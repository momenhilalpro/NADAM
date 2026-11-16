import express from 'express';
import admin from 'firebase-admin';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFilePath = path.join(__dirname, '.env');
if (existsSync(envFilePath)) process.loadEnvFile(envFilePath);

const app = express();
app.use(express.json());

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const serviceAccount = serviceAccountJson ? JSON.parse(serviceAccountJson) : null;
const projectId = serviceAccount?.project_id ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.VITE_FIREBASE_PROJECT_ID;

if (!admin.apps.length) {
    admin.initializeApp({
        credential: serviceAccount
            ? admin.credential.cert(serviceAccount)
            : admin.credential.applicationDefault(),
        ...(projectId ? { projectId } : {})
    });
}

const PRIMARY_ADMIN_EMAIL = 'momenhilal6942@gmail.com';
const firestore = admin.firestore();
const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || '';
if (!geminiApiKey) {
    console.warn('[AI] GEMINI_API_KEY is not configured; Gemini services are disabled.');
}
const geminiRequestWindows = new Map();
const GEMINI_REQUEST_LIMIT = 10;
const GEMINI_REQUEST_WINDOW_MS = 60_000;

function consumeGeminiRequest(ipAddress) {
    const now = Date.now();
    const currentWindow = geminiRequestWindows.get(ipAddress);
    if (!currentWindow || currentWindow.resetAt <= now) {
        geminiRequestWindows.set(ipAddress, { count: 1, resetAt: now + GEMINI_REQUEST_WINDOW_MS });
    } else if (currentWindow.count >= GEMINI_REQUEST_LIMIT) {
        return Math.ceil((currentWindow.resetAt - now) / 1000);
    } else {
        currentWindow.count += 1;
    }

    if (geminiRequestWindows.size > 1000) {
        for (const [ip, window] of geminiRequestWindows) {
            if (window.resetAt <= now) geminiRequestWindows.delete(ip);
        }
    }
    return 0;
}

app.post('/api/ai/generate', async (request, response) => {
    const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt.trim() : '';
    if (!prompt || prompt.length > 16_000) {
        return response.status(400).json({ error: 'نص الطلب غير صالح.' });
    }
    if (!geminiApiKey) {
        return response.status(503).json({ error: 'خدمة الاقتراحات الذكية غير مهيأة على الخادم.' });
    }

    const retryAfterSeconds = consumeGeminiRequest(request.ip || request.socket.remoteAddress || 'unknown');
    if (retryAfterSeconds) {
        response.set('Retry-After', String(retryAfterSeconds));
        return response.status(429).json({ error: 'تم تجاوز الحد المؤقت لطلبات المساعد الذكي.' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);
    try {
        const upstreamResponse = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': geminiApiKey
                },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                signal: controller.signal
            }
        );
        const result = await upstreamResponse.json().catch(() => null);
        if (upstreamResponse.status === 429) {
            const retryAfter = Number(upstreamResponse.headers.get('retry-after'));
            if (Number.isFinite(retryAfter) && retryAfter > 0) response.set('Retry-After', String(retryAfter));
            return response.status(429).json({ error: 'تم بلوغ حد استخدام Gemini؛ أعد المحاولة لاحقاً.' });
        }
        if (!upstreamResponse.ok) {
            console.error(`Gemini request failed with status ${upstreamResponse.status}.`);
            return response.status(502).json({ error: 'تعذر إنشاء الاقتراحات الذكية حالياً.' });
        }

        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) return response.status(502).json({ error: 'لم تُرجع خدمة Gemini نصاً صالحاً.' });
        response.set('Cache-Control', 'no-store');
        return response.status(200).json({ text });
    } catch (error) {
        console.error('Gemini request failed:', error.name === 'AbortError' ? 'request timed out' : error.message);
        return response.status(error.name === 'AbortError' ? 504 : 502)
            .json({ error: 'تعذر الاتصال بخدمة الاقتراحات الذكية.' });
    } finally {
        clearTimeout(timeoutId);
    }
});

async function requireAdmin(request, response, next) {
    try {
        const authorization = request.headers.authorization || '';
        const token = authorization.startsWith('Bearer ')
            ? authorization.slice(7).trim()
            : '';
        if (!token) return response.status(401).json({ error: 'Authentication required.' });

        const decodedToken = await admin.auth().verifyIdToken(token);
        const roleDocument = await firestore.collection('users').doc(decodedToken.uid).get();
        const isAdmin = decodedToken.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL
            || roleDocument.data()?.role === 'admin';

        if (!isAdmin) return response.status(403).json({ error: 'Admin access required.' });
        request.adminUid = decodedToken.uid;
        next();
    } catch (error) {
        console.error('Admin authorization failed:', error);
        return response.status(401).json({ error: 'Invalid or expired authentication token.' });
    }
}

function isCompletedOrder(order) {
    const status = String(order.status || '').trim().toLowerCase();
    const deliveryStage = String(order.deliveryStage || '').trim().toLowerCase();
    return status === 'completed' || status === 'delivered' || deliveryStage === 'delivered';
}

function isCountableOrder(order) {
    const returnStatus = String(order.returnRequest?.status || '').trim().toLowerCase();
    return isCompletedOrder(order) && !['approved', 'completed', 'returned', 'refunded'].includes(returnStatus);
}

function parseProductId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const productId = Number(value);
    return Number.isSafeInteger(productId) ? productId : null;
}

async function requireAuthenticatedUser(request, response, next) {
    try {
        const authorization = request.headers.authorization || '';
        const token = authorization.startsWith('Bearer ')
            ? authorization.slice(7).trim()
            : '';
        if (!token) return response.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
        request.authUser = await admin.auth().verifyIdToken(token);
        return next();
    } catch (error) {
        console.error('User authorization failed:', error);
        return response.status(401).json({ error: 'انتهت صلاحية جلسة الدخول. سجّل الدخول مجدداً.' });
    }
}

app.get('/api/products/:productId/sales', async (request, response) => {
    const productId = parseProductId(request.params.productId);
    if (productId === null) {
        return response.status(400).json({ error: 'معرّف المنتج غير صالح.' });
    }

    try {
        const orders = await firestore.collection('orders')
            .where('productId', '==', productId)
            .get();
        const soldCount = orders.docs.reduce((total, orderDocument) => {
            const order = orderDocument.data();
            if (!isCountableOrder(order)) return total;
            const quantity = Number(order.quantity);
            return Number.isSafeInteger(quantity) && quantity > 0 ? total + quantity : total;
        }, 0);
        if (!Number.isSafeInteger(soldCount)) throw new Error('Sold quantity exceeds the safe integer range.');
        response.set('Cache-Control', 'no-store');
        return response.status(200).json({ productId, soldCount });
    } catch (error) {
        console.error(`Product sales count query failed for ${productId}:`, error);
        const credentialsMissing = error.message?.includes('Could not load the default credentials');
        return response.status(credentialsMissing ? 503 : 500).json({
            error: credentialsMissing
                ? 'خدمة المبيعات غير مهيأة على الخادم. أعد تشغيلها بعد إعداد بيانات اعتماد Firebase Admin.'
                : 'تعذر تحميل عدد المبيعات حالياً.'
        });
    }
});

app.post('/api/products/:productId/reviews', requireAuthenticatedUser, async (request, response) => {
    const productId = parseProductId(request.params.productId);
    const rating = Number(request.body?.rating);
    const comment = typeof request.body?.comment === 'string' ? request.body.comment.trim() : '';
    if (productId === null) {
        return response.status(400).json({ error: 'معرّف المنتج غير صالح.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return response.status(400).json({ error: 'اختر تقييماً من نجمة واحدة إلى 5 نجوم.' });
    }
    if (comment.length < 3 || comment.length > 1000) {
        return response.status(400).json({ error: 'يجب أن يتراوح نص المراجعة بين 3 و1000 حرف.' });
    }

    const uid = request.authUser.uid;
    try {
        const userOrders = await firestore.collection('orders')
            .where('userId', '==', uid)
            .get();
        const hasCompletedPurchase = userOrders.docs.some(orderDocument => {
            const order = orderDocument.data();
            return Number(order.productId) === productId && isCountableOrder(order);
        });
        if (!hasCompletedPurchase) {
            return response.status(403).json({ error: 'يمكن للمشترين الذين اكتمل طلبهم فقط تقييم هذا المنتج.' });
        }

        const userDocument = await firestore.collection('users').doc(uid).get();
        const profile = userDocument.data() || {};
        const email = String(request.authUser.email || '').trim();
        const customerName = String(profile.displayName || profile.name || request.authUser.name || email.split('@')[0] || '')
            .trim()
            .slice(0, 100);
        if (!customerName) {
            return response.status(400).json({ error: 'أكمل اسمك في ملف الحساب قبل إضافة مراجعة.' });
        }

        const ratingRef = firestore.collection('ratings').doc(`${uid}_${productId}`);
        const existingRating = await ratingRef.get();
        if (existingRating.exists && existingRating.data()?.userId !== uid) {
            return response.status(409).json({ error: 'تعذر حفظ التقييم بسبب تعارض في بياناته.' });
        }

        const ratingData = {
            productId,
            userId: uid,
            customerName,
            rating,
            comment,
            verifiedPurchase: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: existingRating.exists && existingRating.data()?.createdAt
                ? existingRating.data().createdAt
                : admin.firestore.FieldValue.serverTimestamp()
        };
        await ratingRef.set(ratingData);
        return response.status(200).json({ success: true, verifiedPurchase: true });
    } catch (error) {
        console.error(`Verified product review write failed for ${productId}:`, error);
        return response.status(500).json({ error: 'تعذر حفظ المراجعة حالياً.' });
    }
});

app.delete('/api/admin/users/:uid', requireAdmin, async (request, response) => {
    const { uid } = request.params;
    if (!uid || uid.length > 128 || uid.includes('/') || uid.includes('..')) {
        return response.status(400).json({ error: 'Invalid user UID.' });
    }
    if (uid === request.adminUid) {
        return response.status(400).json({ error: 'You cannot delete the currently authenticated admin.' });
    }

    try {
        const userDocument = await firestore.collection('users').doc(uid).get();
        if (userDocument.exists && userDocument.data()?.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL) {
            return response.status(403).json({ error: 'The primary administrator account is protected.' });
        }

        try {
            await admin.auth().deleteUser(uid);
        } catch (error) {
            if (error.code !== 'auth/user-not-found') throw error;
        }

        await firestore.collection('users').doc(uid).delete();
        return response.status(200).json({ success: true, uid });
    } catch (error) {
        console.error('Complete user deletion failed:', error);
        return response.status(500).json({ error: 'Failed to delete the user completely.' });
    }
});

app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API endpoint not found.' });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('/{*path}', (_request, response) => {
    response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const port = Number(process.env.PORT || 3000);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(port, () => console.log(`Store server listening on port ${port}`));
}

export default app;

