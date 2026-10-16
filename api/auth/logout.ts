import { globalSessions, handleCors, sendJson } from '../_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  if (token && globalSessions[token]) {
    delete globalSessions[token];
  }

  return sendJson(res, 200, { success: true, message: 'تم تسجيل الخروج بنجاح' });
}
