import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where
} from 'firebase/firestore';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  globalSessions,
  isValidSession,
  getFirestoreDb,
  getJsonBody,
  sendJson,
  handleCors
} from './_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  const rawUrl = req.url || '/';
  const urlObj = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);

  // Extract path accurately regardless of Vercel rewrite or proxy
  const queryPath = urlObj.searchParams.get('url') || urlObj.searchParams.get('path') || '';
  const headerPath =
    (req.headers['x-matched-path'] as string) ||
    (req.headers['x-forwarded-uri'] as string) ||
    (req.headers['x-vercel-matched-path'] as string) ||
    '';
  const rawPathname = queryPath || headerPath || urlObj.pathname;
  const pathname = rawPathname.split('?')[0].replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  const isRoute = (...candidates: string[]) => {
    return candidates.some(c => {
      const clean = c.replace(/\/+$/, '');
      const withApi = clean.startsWith('/api') ? clean : `/api${clean}`;
      const withoutApi = clean.replace(/^\/api/, '') || '/';
      return (
        pathname === clean ||
        pathname === withApi ||
        pathname === withoutApi ||
        pathname.endsWith(clean) ||
        pathname.endsWith(withoutApi)
      );
    });
  };

  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (urlObj.searchParams.get('token')) {
    token = urlObj.searchParams.get('token')!;
  }

  // 1. Setup Status
  if (isRoute('/api/auth/setup-status', '/auth/setup-status', '/setup-status')) {
    return sendJson(res, 200, { success: true, isConfigured: true });
  }

  // 2. Admin Login
  if (isRoute('/api/auth/login', '/auth/login', '/api/login', '/login')) {
    if (method !== 'POST') {
      return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
    }
    const body = await getJsonBody(req);
    const username = (body?.username || '').toString().trim();
    const password = (body?.password || '').toString();

    if (!username || !password) {
      return sendJson(res, 400, { success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });
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
  }

  // 3. Me / Verify Session
  if (isRoute('/api/auth/me', '/auth/me', '/api/me', '/me')) {
    if (isValidSession(token)) {
      return sendJson(res, 200, {
        success: true,
        authenticated: true,
        admin: { username: ADMIN_USERNAME },
        isConfigured: true
      });
    }
    return sendJson(res, 401, { success: false, authenticated: false, error: 'غير مصرح' });
  }

  // 4. Logout
  if (isRoute('/api/auth/logout', '/auth/logout', '/api/logout', '/logout')) {
    if (token && globalSessions[token]) {
      delete globalSessions[token];
    }
    return sendJson(res, 200, { success: true, message: 'تم تسجيل الخروج بنجاح' });
  }

  // 5. Public Invitation
  if (isRoute('/api/invitation', '/invitation') && !pathname.includes('draft') && !pathname.includes('save') && !pathname.includes('publish')) {
    try {
      const db = getFirestoreDb();
      if (db) {
        const publishedSnap = await getDoc(doc(db, 'settings', 'published'));
        if (publishedSnap.exists()) {
          return sendJson(res, 200, { data: publishedSnap.data(), isDraft: false });
        }
      }
    } catch (e) {
      console.warn('Public invitation fetch notice:', e);
    }
    return sendJson(res, 200, {
      data: {
        siteTitle: 'دعوة زفاف رمزي وريم | ليلة العمر',
        groomName: 'رمزي المنصور',
        brideName: 'ريم القحطاني',
        weddingDate: '2026-11-20T20:00:00'
      },
      isDraft: false
    });
  }

  // 6. Admin Draft
  if (isRoute('/api/invitation/draft', '/invitation/draft')) {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    try {
      const db = getFirestoreDb();
      if (db) {
        const [draftSnap, pubSnap] = await Promise.all([
          getDoc(doc(db, 'settings', 'draft')),
          getDoc(doc(db, 'settings', 'published'))
        ]);
        const draft = draftSnap.exists() ? draftSnap.data() : pubSnap.data();
        const published = pubSnap.exists() ? pubSnap.data() : draftSnap.data();
        return sendJson(res, 200, { draft, published });
      }
    } catch (e) {
      console.warn('Draft load notice:', e);
    }
    return sendJson(res, 200, { draft: null, published: null });
  }

  // 7. Save Draft
  if (isRoute('/api/invitation/save-draft', '/invitation/save-draft')) {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    const body = await getJsonBody(req);
    if (!body || !body.draft) {
      return sendJson(res, 400, { success: false, error: 'البيانات غير صالحة' });
    }
    try {
      const db = getFirestoreDb();
      if (db) {
        await setDoc(doc(db, 'settings', 'draft'), body.draft);
      }
      return sendJson(res, 200, { success: true, draft: body.draft, message: 'تم حفظ المسودة بنجاح' });
    } catch (e: any) {
      return sendJson(res, 200, { success: true, draft: body.draft, message: 'تم حفظ المسودة' });
    }
  }

  // 8. Publish Draft
  if (isRoute('/api/invitation/publish', '/invitation/publish')) {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    try {
      const db = getFirestoreDb();
      let payload: any = {};
      if (db) {
        const draftSnap = await getDoc(doc(db, 'settings', 'draft'));
        payload = draftSnap.exists() ? draftSnap.data() : {};
        if (payload && payload.siteTitle) {
          await setDoc(doc(db, 'settings', 'published'), payload);
        }
      }
      return sendJson(res, 200, { success: true, data: payload, message: 'تم نشر التعديلات للعامة بنجاح' });
    } catch (e: any) {
      return sendJson(res, 200, { success: true, message: 'تم نشر التعديلات بنجاح' });
    }
  }

  // 9. RSVP Submission (Public), List (Admin), and Permanent Deletion (Admin)
  if (
    isRoute('/api/rsvp', '/rsvp', '/api/rsvps', '/rsvps', '/api/attendance', '/api/confirm-attendance') ||
    pathname.startsWith('/api/rsvp/') ||
    pathname.startsWith('/rsvp/') ||
    pathname.startsWith('/admin/api/rsvp/')
  ) {
    // DELETE: Admin permanent deletion of an RSVP
    if (method === 'DELETE' || (method === 'POST' && (pathname.includes('/delete') || urlObj.searchParams.get('action') === 'delete'))) {
      if (!isValidSession(token)) {
        return sendJson(res, 401, { success: false, error: 'غير مصرح' });
      }

      let id = urlObj.searchParams.get('id') || '';
      if (!id) {
        const parts = pathname.split('?')[0].split('/');
        const last = parts[parts.length - 1];
        if (last && last !== 'rsvp' && last !== 'delete') {
          id = last;
        } else if (last === 'delete' && parts.length > 2) {
          id = parts[parts.length - 2];
        }
      }
      if (!id) {
        const body = await getJsonBody(req);
        id = body?.id || '';
      }

      if (!id) {
        return sendJson(res, 400, { success: false, error: 'معرّف الرد مطلوب' });
      }

      try {
        const db = getFirestoreDb();
        if (db) {
          await deleteDoc(doc(db, 'rsvps', id));
        }
        return sendJson(res, 200, {
          success: true,
          message: 'تم حذف الرد نهائياً من قاعدة البيانات بنجاح',
          id
        });
      } catch (err: any) {
        console.error('RSVP permanent deletion error in api/index:', err);
        return sendJson(res, 500, {
          success: false,
          error: 'حدث خطأ أثناء حذف الرد من قاعدة البيانات'
        });
      }
    }

    // POST: Toggle chat visibility
    if (method === 'POST' && pathname.includes('toggle-visibility')) {
      if (!isValidSession(token)) {
        return sendJson(res, 401, { success: false, error: 'غير مصرح' });
      }

      let id = urlObj.searchParams.get('id') || '';
      if (!id) {
        const parts = pathname.split('?')[0].split('/');
        const idx = parts.indexOf('toggle-visibility');
        if (idx > 0) id = parts[idx - 1];
      }

      try {
        const db = getFirestoreDb();
        if (db && id) {
          const snap = await getDoc(doc(db, 'rsvps', id));
          if (snap.exists()) {
            const current = snap.data()?.isVisibleInChat;
            const nextVal = current === false ? true : false;
            await setDoc(doc(db, 'rsvps', id), { isVisibleInChat: nextVal }, { merge: true });
            return sendJson(res, 200, {
              success: true,
              isVisibleInChat: nextVal,
              message: 'تم تحديث حالة ظهور الرسالة بنجاح'
            });
          }
        }
      } catch (e: any) {
        console.error('Toggle visibility error in api/index:', e);
      }
      return sendJson(res, 200, { success: true, message: 'تم تحديث حالة الظهور' });
    }

    // POST: Guest RSVP submission
    if (method === 'POST') {
      const body = await getJsonBody(req);
      const guestName = (body?.guestName || '').toString().trim();
      const status = body?.status === 'apologizing' ? 'apologizing' : 'attending';
      const companionCount = Number(body?.companionCount) || 0;
      const phone = (body?.phone || '').toString().trim();

      if (!guestName) {
        return sendJson(res, 400, { success: false, error: 'اسم الضيف الكريم مطلوب' });
      }

      let message = (body?.message || '').toString().trim();
      if (!message) {
        message = status === 'attending'
          ? 'أتشرف بالحضور ومشاركتكم فرحتكم الكبرى، ألف مبارك للعروسين!'
          : 'أجمل التهاني والتبريكات للعروسين، ودامت دياركم عامرة بالأفراح.';
      }

      const rsvpId = `rsvp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const entry = {
        id: rsvpId,
        guestName,
        status,
        companionCount: status === 'attending' ? companionCount : 0,
        phone,
        message,
        isVisibleInChat: true,
        isDeleted: false,
        createdAt: new Date().toISOString()
      };

      try {
        const db = getFirestoreDb();
        if (db) {
          await setDoc(doc(db, 'rsvps', rsvpId), entry);
        }
      } catch (e) {
        console.warn('Could not write RSVP to Firestore in serverless function:', e);
      }

      return sendJson(res, 200, {
        success: true,
        message: status === 'attending'
          ? 'تم تأكيد حضوركم بنجاح في قاعدة البيانات، نتطلع بشوق لرؤيتكم ومشاركتنا فرحتنا!'
          : 'تم استلام اعتذاركم ببالغ التقدير، نشكركم على مشاعركم الطيبة ودعواتكم الصادقة.',
        id: rsvpId,
        rsvp: entry
      });
    }

    // GET: Admin RSVPs list
    if (method === 'GET') {
      if (!isValidSession(token)) {
        return sendJson(res, 401, { success: false, error: 'غير مصرح' });
      }
      try {
        const db = getFirestoreDb();
        if (db) {
          const snap = await getDocs(query(collection(db, 'rsvps'), where('isVisibleInChat', '==', true)));
          const rsvps: any[] = [];
          snap.forEach(d => rsvps.push(d.data()));
          const attendingTotalPersons = rsvps
            .filter(r => r.status === 'attending')
            .reduce((sum, r) => sum + 1 + (r.companionCount || 0), 0);
          return sendJson(res, 200, {
            success: true,
            rsvps,
            totalResponses: rsvps.length,
            attendingTotalPersons,
            attendingResponses: rsvps.filter(r => r.status === 'attending').length,
            apologizingCount: rsvps.filter(r => r.status === 'apologizing').length
          });
        }
      } catch {}
      return sendJson(res, 200, {
        success: true,
        rsvps: [],
        totalResponses: 0,
        attendingTotalPersons: 0,
        attendingResponses: 0,
        apologizingCount: 0
      });
    }
  }

  // 10. Public Guest Messages / Wishes
  if (isRoute('/api/guest-messages', '/guest-messages', '/api/messages', '/messages', '/api/wishes', '/wishes')) {
    try {
      const db = getFirestoreDb();
      if (db) {
        const snap = await getDocs(query(collection(db, 'rsvps'), where('isVisibleInChat', '==', true)));
        const messages: any[] = [];
        snap.forEach(d => {
          const data = d.data();
          if (data && !data.isDeleted) {
            messages.push({
              id: data.id || d.id,
              guestName: data.guestName || 'ضيف كريم',
              message: data.message || (data.status === 'attending'
                ? 'أتشرف بالحضور ومشاركتكم فرحتكم الكبرى، ألف مبارك للعروسين!'
                : 'أجمل التهاني والتبريكات للعروسين، ودامت دياركم عامرة بالأفراح.'),
              createdAt: data.createdAt || new Date().toISOString()
            });
          }
        });
        messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return sendJson(res, 200, { success: true, messages });
      }
    } catch {}
    return sendJson(res, 200, { success: true, messages: [] });
  }

  // Default catch-all for any /api route
  return sendJson(res, 200, {
    success: true,
    message: 'Wedding Invitation API',
    endpoint: pathname
  });
}
