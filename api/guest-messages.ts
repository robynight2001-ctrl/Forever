import { getDocs, collection, query, where } from 'firebase/firestore';
import { getFirestoreDb, handleCors, sendJson } from './_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

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
  } catch (err) {
    console.warn('Guest messages fetch error:', err);
  }

  return sendJson(res, 200, { success: true, messages: [] });
}
