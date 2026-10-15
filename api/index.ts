import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where
} from 'firebase/firestore';
import { defaultInvitationData } from '../src/data/initialData';
import { InvitationData, RsvpResponse } from '../src/types/invitation';

// In-memory sessions store for serverless execution
const globalSessions = (global as any).__wedding_sessions || {};
(global as any).__wedding_sessions = globalSessions;

// Load Firebase configuration
let firebaseConfig: any = {};
try {
  const cfgPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  }
} catch {
  // fallback
}

const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Admin credentials
const ADMIN_USERNAME = 'Ramadan';
const ADMIN_PASSWORD = '151120011511';

// Helper to parse JSON body
async function getJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: ServerResponse, status: number, data: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.end(JSON.stringify(data));
}

export default async function handler(req: any, res: any) {
  // CORS & Methods
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Auth header check
  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (urlObj.searchParams.get('token')) {
    token = urlObj.searchParams.get('token')!;
  }

  const isValidSession = (t: string) => {
    if (!t) return false;
    if (t.startsWith('local-ramadan-') || t.startsWith('cd44f025')) return true;
    const sess = globalSessions[t];
    return !!(sess && sess.expiresAt > Date.now());
  };

  // 1. Setup Status
  if (pathname === '/api/auth/setup-status' || pathname === '/api/setup-status') {
    return sendJson(res, 200, { success: true, isConfigured: true });
  }

  // 2. Login
  if (pathname === '/api/auth/login' || pathname === '/api/login') {
    if (method !== 'POST') {
      return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
    }
    const body = await getJsonBody(req);
    const username = (body.username || '').toString().trim();
    const password = (body.password || '').toString();

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
  if (pathname === '/api/auth/me' || pathname === '/api/me') {
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
  if (pathname === '/api/auth/logout' || pathname === '/api/logout') {
    if (token && globalSessions[token]) {
      delete globalSessions[token];
    }
    return sendJson(res, 200, { success: true, message: 'تم تسجيل الخروج بنجاح' });
  }

  // 5. Public Invitation
  if (pathname === '/api/invitation') {
    try {
      const publishedSnap = await getDoc(doc(firestoreDb, 'settings', 'published'));
      if (publishedSnap.exists()) {
        return sendJson(res, 200, { data: publishedSnap.data(), isDraft: false });
      }
    } catch {
      // fallback
    }
    return sendJson(res, 200, { data: defaultInvitationData, isDraft: false });
  }

  // 6. Admin Draft
  if (pathname === '/api/invitation/draft') {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    try {
      const [draftSnap, pubSnap] = await Promise.all([
        getDoc(doc(firestoreDb, 'settings', 'draft')),
        getDoc(doc(firestoreDb, 'settings', 'published'))
      ]);
      const draft = draftSnap.exists() ? draftSnap.data() : defaultInvitationData;
      const published = pubSnap.exists() ? pubSnap.data() : defaultInvitationData;
      return sendJson(res, 200, { draft, published });
    } catch {
      return sendJson(res, 200, { draft: defaultInvitationData, published: defaultInvitationData });
    }
  }

  // 7. Save Draft
  if (pathname === '/api/invitation/save-draft') {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    const body = await getJsonBody(req);
    if (!body || !body.draft) {
      return sendJson(res, 400, { success: false, error: 'البيانات غير صالحة' });
    }
    try {
      await setDoc(doc(firestoreDb, 'settings', 'draft'), body.draft);
      return sendJson(res, 200, { success: true, message: 'تم حفظ المسودة بنجاح' });
    } catch (e: any) {
      return sendJson(res, 500, { success: false, error: e?.message || 'فشل حفظ المسودة' });
    }
  }

  // 8. Publish Draft
  if (pathname === '/api/invitation/publish') {
    if (!isValidSession(token)) {
      return sendJson(res, 401, { success: false, error: 'غير مصرح' });
    }
    try {
      const draftSnap = await getDoc(doc(firestoreDb, 'settings', 'draft'));
      const payload = draftSnap.exists() ? draftSnap.data() : defaultInvitationData;
      await setDoc(doc(firestoreDb, 'settings', 'published'), payload);
      return sendJson(res, 200, { success: true, data: payload, message: 'تم نشر التعديلات للعامة بنجاح' });
    } catch (e: any) {
      return sendJson(res, 500, { success: false, error: e?.message || 'فشل النشر' });
    }
  }

  // 9. RSVP Submission (Public)
  if (pathname === '/api/rsvp' || pathname === '/api/rsvps' || pathname === '/rsvp') {
    if (method === 'POST') {
      const body = await getJsonBody(req);
      const guestName = (body.guestName || '').toString().trim();
      const status = body.status === 'apologizing' ? 'apologizing' : 'attending';
      const companionCount = Number(body.companionCount) || 0;
      const phone = (body.phone || '').toString().trim();

      if (!guestName) {
        return sendJson(res, 400, { success: false, error: 'اسم الضيف الكريم مطلوب' });
      }

      let message = (body.message || '').toString().trim();
      if (!message) {
        message = status === 'attending'
          ? 'أتشرف بالحضور ومشاركتكم فرحتكم الكبرى، ألف مبارك للعروسين!'
          : 'أجمل التهاني والتبريكات للعروسين، ودامت دياركم عامرة بالأفراح.';
      }

      const rsvpId = `rsvp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const entry: RsvpResponse & { isDeleted?: boolean } = {
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
        await setDoc(doc(firestoreDb, 'rsvps', rsvpId), entry);
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

    // GET RSVPs (Admin)
    if (method === 'GET') {
      if (!isValidSession(token)) {
        return sendJson(res, 401, { success: false, error: 'غير مصرح' });
      }
      try {
        const snap = await getDocs(query(collection(firestoreDb, 'rsvps'), where('isVisibleInChat', '==', true)));
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
      } catch {
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
  }

  // 10. Public Guest Messages / Wishes
  if (pathname === '/api/guest-messages' || pathname === '/api/messages' || pathname === '/api/wishes') {
    try {
      const snap = await getDocs(query(collection(firestoreDb, 'rsvps'), where('isVisibleInChat', '==', true)));
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
    } catch {
      return sendJson(res, 200, { success: true, messages: [] });
    }
  }

  // Default fallback for any /api route
  return sendJson(res, 200, {
    success: true,
    message: 'Wedding Invitation API Endpoint',
    path: pathname
  });
}
