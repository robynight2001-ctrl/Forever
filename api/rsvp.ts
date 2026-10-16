import { doc, setDoc, deleteDoc, getDocs, getDoc, collection, query, where } from 'firebase/firestore';
import {
  getFirestoreDb,
  getJsonBody,
  handleCors,
  isValidSession,
  sendJson
} from './_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  const rawUrl = req.url || '/';
  const urlObj = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  const method = (req.method || 'GET').toUpperCase();

  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else {
    token = urlObj.searchParams.get('token') || '';
  }

  // DELETE: Permanent deletion of an RSVP entry
  if (method === 'DELETE' || (method === 'POST' && urlObj.pathname.includes('/delete'))) {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }

    let id = urlObj.searchParams.get('id') || req.query?.id || '';
    if (!id) {
      const parts = urlObj.pathname.split('?')[0].split('/');
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
      console.error('RSVP permanent deletion error in serverless:', err);
      return sendJson(res, 500, {
        success: false,
        error: 'حدث خطأ أثناء حذف الرد من قاعدة البيانات'
      });
    }
  }

  // POST: Toggle Chat Visibility
  if (method === 'POST' && urlObj.pathname.includes('toggle-visibility')) {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }

    let id = urlObj.searchParams.get('id') || req.query?.id || '';
    if (!id) {
      const parts = urlObj.pathname.split('?')[0].split('/');
      const idx = parts.indexOf('toggle-visibility');
      if (idx > 0) {
        id = parts[idx - 1];
      }
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
      console.error('Toggle visibility error:', e);
    }
    return sendJson(res, 200, { success: true, message: 'تم تحديث حالة الظهور' });
  }

  // POST: Guest RSVP submission
  if (method === 'POST') {
    try {
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
      } catch (err) {
        console.warn('Could not persist RSVP to Firestore in serverless function:', err);
      }

      return sendJson(res, 200, {
        success: true,
        message: status === 'attending'
          ? 'تم تأكيد حضوركم بنجاح في قاعدة البيانات، نتطلع بشوق لرؤيتكم ومشاركتنا فرحتنا!'
          : 'تم استلام اعتذاركم ببالغ التقدير، نشكركم على مشاعركم الطيبة ودعواتكم الصادقة.',
        id: rsvpId,
        rsvp: entry
      });
    } catch (err: any) {
      console.error('RSVP submission error:', err);
      return sendJson(res, 500, {
        success: false,
        error: 'حدث خطأ أثناء إرسال تأكيد الحضور، يرجى المحاولة مرة أخرى'
      });
    }
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
    } catch (err) {
      console.warn('Admin RSVP fetch error:', err);
    }

    return sendJson(res, 200, {
      success: true,
      rsvps: [],
      totalResponses: 0,
      attendingTotalPersons: 0,
      attendingResponses: 0,
      apologizingCount: 0
    });
  }

  return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
}
