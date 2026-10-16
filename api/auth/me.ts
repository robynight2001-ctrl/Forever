import { ADMIN_USERNAME, handleCors, isValidSession, sendJson } from '../_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    token = urlObj.searchParams.get('token') || '';
  }

  if (isValidSession(token)) {
    return sendJson(res, 200, {
      success: true,
      authenticated: true,
      admin: { username: ADMIN_USERNAME },
      isConfigured: true
    });
  }

  return sendJson(res, 401, {
    success: false,
    authenticated: false,
    error: 'غير مصرح'
  });
}
