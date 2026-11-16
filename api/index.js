import app from '../server.js';

export const config = {
    api: {
        bodyParser: false
    }
};

export default function apiHandler(request, response) {
    const pathParameter = request.query?.path;
    const apiPath = Array.isArray(pathParameter) ? pathParameter.join('/') : pathParameter;
    if (typeof apiPath === 'string' && apiPath) {
        const requestUrl = new URL(request.url, 'http://localhost');
        requestUrl.searchParams.delete('path');
        request.url = `/api/${apiPath}${requestUrl.search}`;
    }

    return app(request, response);
}
