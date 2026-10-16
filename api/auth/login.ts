import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  globalSessions,
  handleCors,
  getJsonBody,
  sendJson
} from '../_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    const body = await getJsonBody(req);
    const username = (body?.username || '').toString().trim();
    const password = (body?.password || '').toString();

    if (!username || !password) {
      return sendJson(res, 400, {
        success: false,
        error: 'اسم المستخدم وكلمة المرور مطلوبان'
      });
    }

    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_PASSWORD) {
      const sessionToken = `ramadan-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
      globalSessions[sessionToken] = {
        username: ADMIN_USERNAME,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
      };

      return sendJson(res, 200, {
        success: true,
        token: sessionToken,
        admin: {
          username: ADMIN_USERNAME,
          updatedAt: new Date().toISOString()
        },
        message: 'تم تسجيل الدخول بنجاح'
      });
    }

    return sendJson(res, 401, {
      success: false,
      error: 'اسم المستخدم أو كلمة المرور غير صحيحة'
    });
  } catch (err: any) {
    console.error('Login handler error:', err);
    return sendJson(res, 500, {
      success: false,
      error: 'حدث خطأ في الخادم أثناء تسجيل الدخول'
    });
  }
}
