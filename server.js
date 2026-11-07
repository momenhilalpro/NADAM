import express from 'express';
import admin from 'firebase-admin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json());

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const serviceAccount = serviceAccountJson ? JSON.parse(serviceAccountJson) : null;

if (!admin.apps.length) {
    admin.initializeApp({
        credential: serviceAccount
            ? admin.credential.cert(serviceAccount)
            : admin.credential.applicationDefault()
    });
}

const PRIMARY_ADMIN_EMAIL = 'momenhilal6942@gmail.com';
const firestore = admin.firestore();

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/{*path}', (_request, response) => {
    response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const port = Number(process.env.PORT || 3000);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(port, () => console.log(`Store server listening on port ${port}`));
}

