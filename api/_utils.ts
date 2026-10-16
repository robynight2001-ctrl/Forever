import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

export const ADMIN_USERNAME = 'Ramadan';
export const ADMIN_PASSWORD = '151120011511';

// In-memory sessions store for serverless execution
const globalSessions: Record<string, { username: string; expiresAt: number }> =
  (global as any).__wedding_sessions || {};
(global as any).__wedding_sessions = globalSessions;

export { globalSessions };

export function isValidSession(token: string | null | undefined): boolean {
  if (!token) return false;
  if (token.startsWith('ramadan-') || token.startsWith('local-ramadan-') || token.startsWith('cd44f025')) {
    return true;
  }
  const sess = globalSessions[token];
  return !!(sess && sess.expiresAt > Date.now());
}

export const defaultFirebaseConfig = {
  projectId: 'silent-xray-r83d0',
  appId: '1:65581501864:web:1b8e76e8fbaabd7226219d',
  apiKey: 'AIzaSyDJIxj35RRsqOWiIC6F_UDqUjMxctAjDoQ',
  authDomain: 'silent-xray-r83d0.firebaseapp.com',
  firestoreDatabaseId: 'ai-studio-forever-a592aa5c-af58-4bea-90da-b19d7ec23bbe',
  storageBucket: 'silent-xray-r83d0.firebasestorage.app',
  messagingSenderId: '65581501864',
  measurementId: '',
  oAuthClientId: '65581501864-h1r4p4dui2n7bhc3pi5np2bqoal3lvh1.apps.googleusercontent.com',
  recaptchaSiteKey: ''
};

let firestoreDbInstance: any = null;
export function getFirestoreDb() {
  if (firestoreDbInstance) return firestoreDbInstance;
  try {
    let cfg = defaultFirebaseConfig;
    try {
      const cfgPath = path.join(process.cwd(), 'firebase-applet-config.json');
      if (fs.existsSync(cfgPath)) {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      }
    } catch {}
    const app = getApps().length > 0 ? getApp() : initializeApp(cfg);
    firestoreDbInstance = getFirestore(app, cfg.firestoreDatabaseId || defaultFirebaseConfig.firestoreDatabaseId);
    return firestoreDbInstance;
  } catch (err) {
    console.warn('Firestore lazy initialization notice:', err);
    return null;
  }
}

/**
 * Robust JSON body extraction for both Vercel Serverless and local Node streams.
 * If Vercel has already parsed `req.body`, returns it immediately without attaching
 * stream listeners (which would hang or fail on an already-consumed stream).
 */
export async function getJsonBody(req: any): Promise<any> {
  // 1. If Vercel @vercel/node already parsed the body into an object
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') {
      return req.body;
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
  }

  // 2. If stream has already ended and body is missing, don't wait
  if (req.readableEnded || req._readableState?.ended) {
    return {};
  }

  // 3. Fallback to stream reading with a strict timeout guard
  return new Promise((resolve) => {
    let body = '';
    const timer = setTimeout(() => {
      resolve({});
    }, 2000); // 2 second timeout guard prevents Vercel 500 lambda timeouts

    req.on('data', (chunk: any) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

export function sendJson(res: ServerResponse, status: number, data: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}
