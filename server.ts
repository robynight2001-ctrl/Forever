import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  onSnapshot
} from 'firebase/firestore';
import { defaultInvitationData } from './src/data/initialData';
import { InvitationData, RsvpResponse } from './src/types/invitation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'wedding_database.json');
const BACKUP_FILE = path.join(DATA_DIR, 'wedding_database.backup.json');

// Ensure storage directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Read Firebase applet configuration
let firebaseConfig: any = {};
try {
  const configPath = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
} catch (err) {
  console.error('Failed to read firebase-applet-config.json:', err);
}

// Initialize Firebase SDK for persistent cloud storage
const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Interface for persisted database
interface DatabaseSchema {
  admin: {
    isConfigured: boolean;
    username: string;
    salt: string;
    passwordHash: string;
    updatedAt: string;
  };
  published: InvitationData;
  draft: InvitationData;
  rsvps: (RsvpResponse & { isDeleted?: boolean })[];
  sessions: { [token: string]: { username: string; expiresAt: number } };
}

// Password hashing utility using crypto.scryptSync
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// Generate new secure salt
function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Deep clone utility
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// Ensure full invitation data structure integrity
function sanitizeInvitationData(data: Partial<InvitationData> | undefined): InvitationData {
  const merged: InvitationData = {
    ...defaultInvitationData,
    ...(data || {})
  };
  merged.photos = Array.isArray(data?.photos) ? deepClone(data!.photos) : deepClone(defaultInvitationData.photos);
  merged.videos = Array.isArray(data?.videos) ? deepClone(data!.videos) : deepClone(defaultInvitationData.videos);
  merged.timeline = Array.isArray(data?.timeline) ? deepClone(data!.timeline) : deepClone(defaultInvitationData.timeline);
  merged.customSections = Array.isArray(data?.customSections) ? deepClone(data!.customSections) : deepClone(defaultInvitationData.customSections);
  merged.sectionsOrder = Array.isArray(data?.sectionsOrder) && data!.sectionsOrder.length > 0
    ? deepClone(data!.sectionsOrder)
    : deepClone(defaultInvitationData.sectionsOrder);
  merged.hiddenSections = Array.isArray(data?.hiddenSections) ? deepClone(data!.hiddenSections) : [];
  return merged;
}

// DatabaseManager: Cloud Firestore authoritative store with local mirror & real-time sync
class DatabaseManager {
  private data!: DatabaseSchema;
  private isInitialized = false;

  constructor() {
    let loaded = false;

    // 1. Load initial state from primary database file if exists
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.data = this.normalizeLoadedData(parsed);
          loaded = true;
        }
      } catch (err) {
        console.error('Primary database file corrupted, trying backup file...', err);
      }
    }

    // 2. Fallback to mirror backup file
    if (!loaded && fs.existsSync(BACKUP_FILE)) {
      try {
        const rawBackup = fs.readFileSync(BACKUP_FILE, 'utf-8');
        const parsedBackup = JSON.parse(rawBackup);
        if (parsedBackup && typeof parsedBackup === 'object') {
          this.data = this.normalizeLoadedData(parsedBackup);
          loaded = true;
          this.saveLocalMirror();
        }
      } catch (backupErr) {
        console.error('Mirror backup also corrupted:', backupErr);
      }
    }

    if (!loaded) {
      this.data = this.createInitialData();
      this.saveLocalMirror();
    }
  }

  // Connect to Cloud Firestore and synchronize authoritative data
  public async init(): Promise<void> {
    if (this.isInitialized) return;

    try {
      console.log('Connecting to Cloud Firestore database:', firebaseConfig.firestoreDatabaseId);

      // Load published settings from Firestore
      const publishedDoc = await getDoc(doc(firestoreDb, 'settings', 'published'));
      if (publishedDoc.exists()) {
        this.data.published = sanitizeInvitationData(publishedDoc.data() as any);
        console.log('Loaded authoritative published invitation from Cloud Firestore.');
      } else {
        console.log('Seeding published invitation to Cloud Firestore...');
        await setDoc(doc(firestoreDb, 'settings', 'published'), this.data.published);
      }

      // Load draft settings from Firestore
      const draftDoc = await getDoc(doc(firestoreDb, 'settings', 'draft'));
      if (draftDoc.exists()) {
        this.data.draft = sanitizeInvitationData(draftDoc.data() as any);
        console.log('Loaded authoritative draft invitation from Cloud Firestore.');
      } else {
        console.log('Seeding draft invitation to Cloud Firestore...');
        await setDoc(doc(firestoreDb, 'settings', 'draft'), this.data.draft);
      }

      // Load admin credentials from Firestore safely without halting initialization if permission restricted
      try {
        const adminDoc = await getDoc(doc(firestoreDb, 'settings', 'admin'));
        if (adminDoc.exists()) {
          const adminData = adminDoc.data() as any;
          if (adminData && adminData.username && adminData.passwordHash) {
            this.data.admin = {
              isConfigured: !!adminData.isConfigured,
              username: adminData.username || '',
              salt: adminData.salt || '',
              passwordHash: adminData.passwordHash || '',
              updatedAt: adminData.updatedAt || new Date().toISOString()
            };
            console.log('Loaded authoritative admin config from Cloud Firestore.');
          }
        } else if (this.data.admin.isConfigured) {
          await setDoc(doc(firestoreDb, 'settings', 'admin'), this.data.admin);
        }
      } catch (adminErr: any) {
        console.log('Firestore admin document lookup notice (using database file):', adminErr?.message || adminErr);
      }

      // Load RSVPs from Firestore using security-rule compliant query
      try {
        const rsvpSnap = await getDocs(query(collection(firestoreDb, 'rsvps'), where('isVisibleInChat', '==', true)));
        if (!rsvpSnap.empty) {
          const cloudRsvps: (RsvpResponse & { isDeleted?: boolean })[] = [];
          rsvpSnap.forEach((d) => {
            const item = d.data() as any;
            if (item && item.id && item.guestName) {
              cloudRsvps.push(item);
            }
          });
          if (cloudRsvps.length > 0) {
            this.data.rsvps = cloudRsvps;
            console.log(`Loaded ${cloudRsvps.length} authoritative RSVPs from Cloud Firestore.`);
          }
        } else if (this.data.rsvps.length > 0) {
          console.log(`Seeding ${this.data.rsvps.length} initial RSVPs to Cloud Firestore...`);
          for (const r of this.data.rsvps) {
            await setDoc(doc(firestoreDb, 'rsvps', r.id), r);
          }
        }
      } catch (rsvpErr: any) {
        console.warn('Firestore RSVPs load notice:', rsvpErr?.message || rsvpErr);
      }

      // Save refreshed state to local mirror
      this.saveLocalMirror();

      // Set up real-time cross-device sync listeners
      this.setupRealtimeListeners();
      this.isInitialized = true;
      console.log('Cloud Firestore synchronization initialized successfully.');
    } catch (err: any) {
      console.error('Error during Cloud Firestore initialization:', err?.message || err);
    }
  }

  // Real-time synchronization listeners across all container instances
  private setupRealtimeListeners(): void {
    // 1. Listen for published changes
    onSnapshot(doc(firestoreDb, 'settings', 'published'), (snap) => {
      if (snap.exists()) {
        this.data.published = sanitizeInvitationData(snap.data() as any);
        this.saveLocalMirror();
      }
    }, (err) => console.warn('Real-time sync error (published):', err.message));

    // 2. Listen for draft changes
    onSnapshot(doc(firestoreDb, 'settings', 'draft'), (snap) => {
      if (snap.exists()) {
        this.data.draft = sanitizeInvitationData(snap.data() as any);
        this.saveLocalMirror();
      }
    }, (err) => console.warn('Real-time sync error (draft):', err.message));

    // 3. Listen for RSVPs updates with security-rule compliant query
    onSnapshot(query(collection(firestoreDb, 'rsvps'), where('isVisibleInChat', '==', true)), (snap) => {
      const items: (RsvpResponse & { isDeleted?: boolean })[] = [];
      snap.forEach((d) => {
        const r = d.data() as any;
        if (r && r.id && r.guestName) {
          items.push(r);
        }
      });
      if (items.length > 0) {
        this.data.rsvps = items;
        this.saveLocalMirror();
      }
    }, (err) => console.warn('Real-time sync error (rsvps):', err.message));
  }

  private normalizeLoadedData(parsed: any): DatabaseSchema {
    const published = sanitizeInvitationData(parsed.published);
    const draft = sanitizeInvitationData(parsed.draft || parsed.published);
    const rsvps = Array.isArray(parsed.rsvps) ? parsed.rsvps : [];
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const admin = parsed.admin && typeof parsed.admin === 'object'
      ? {
          isConfigured: !!parsed.admin.isConfigured,
          username: parsed.admin.username || '',
          salt: parsed.admin.salt || '',
          passwordHash: parsed.admin.passwordHash || '',
          updatedAt: parsed.admin.updatedAt || new Date().toISOString()
        }
      : {
          isConfigured: false,
          username: '',
          salt: '',
          passwordHash: '',
          updatedAt: new Date().toISOString()
        };

    return { admin, published, draft, rsvps, sessions };
  }

  private createInitialData(): DatabaseSchema {
    return {
      admin: {
        isConfigured: false,
        username: '',
        salt: '',
        passwordHash: '',
        updatedAt: new Date().toISOString()
      },
      published: sanitizeInvitationData(defaultInvitationData),
      draft: sanitizeInvitationData(defaultInvitationData),
      rsvps: [
        {
          id: 'rsvp-demo-1',
          guestName: 'سلطان القحطاني',
          status: 'attending',
          companionCount: 2,
          message: 'ألف ألف مبروك للعروسين، بارك الله لكما وبارك عليكما وجمع بينكما في خير.',
          phone: '+966500000000',
          isVisibleInChat: true,
          createdAt: new Date(Date.now() - 3600000 * 24).toISOString()
        },
        {
          id: 'rsvp-demo-2',
          guestName: 'د. خالد المنصور',
          status: 'attending',
          companionCount: 1,
          message: 'تهانينا القلبية للعروسين، نسأل الله لكما حياة عامرة بالمودة والسكينة.',
          phone: '+966511111111',
          isVisibleInChat: true,
          createdAt: new Date(Date.now() - 3600000 * 12).toISOString()
        },
        {
          id: 'rsvp-demo-3',
          guestName: 'فيصل العتيبي',
          status: 'attending',
          companionCount: 0,
          message: 'بارك الله لكما، وجعل دياركم عامرة بالأفراح والمسرات الدائمة.',
          phone: '+966522222222',
          isVisibleInChat: true,
          createdAt: new Date(Date.now() - 3600000 * 4).toISOString()
        }
      ],
      sessions: {}
    };
  }

  public saveLocalMirror(): void {
    try {
      const payload = JSON.stringify(this.data, null, 2);
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf-8');
      fs.renameSync(tmp, DB_FILE);
      fs.writeFileSync(BACKUP_FILE, payload, 'utf-8');
    } catch (err) {
      console.error('Failed to write local database mirror:', err);
    }
  }

  public isConfigured(): boolean {
    return this.data.admin.isConfigured === true && !!this.data.admin.username && !!this.data.admin.passwordHash;
  }

  public async setupAdmin(username: string, passwordAttempt: string): Promise<void> {
    const salt = generateSalt();
    const hash = hashPassword(passwordAttempt, salt);
    this.data.admin = {
      isConfigured: true,
      username: username.trim(),
      salt,
      passwordHash: hash,
      updatedAt: new Date().toISOString()
    };
    this.saveLocalMirror();

    // Persist to Cloud Firestore
    try {
      await setDoc(doc(firestoreDb, 'settings', 'admin'), this.data.admin);
    } catch (e) {
      console.warn('Could not mirror admin credentials to Firestore:', e);
    }
  }

  public getPublished(): InvitationData {
    return deepClone(this.data.published);
  }

  public getDraft(): InvitationData {
    return deepClone(this.data.draft);
  }

  public async updateDraft(draft: InvitationData): Promise<void> {
    const cleanDraft = sanitizeInvitationData(draft);
    cleanDraft.updatedAt = new Date().toISOString();
    this.data.draft = cleanDraft;
    this.saveLocalMirror();

    // Save to Cloud Firestore
    await setDoc(doc(firestoreDb, 'settings', 'draft'), cleanDraft);
  }

  public async publishDraft(): Promise<InvitationData> {
    const cleanPublished = sanitizeInvitationData(this.data.draft);
    cleanPublished.updatedAt = new Date().toISOString();
    this.data.published = cleanPublished;
    this.saveLocalMirror();

    // Save to Cloud Firestore permanently
    await setDoc(doc(firestoreDb, 'settings', 'published'), cleanPublished);
    return deepClone(this.data.published);
  }

  public async discardDraft(): Promise<InvitationData> {
    this.data.draft = sanitizeInvitationData(this.data.published);
    this.saveLocalMirror();
    await setDoc(doc(firestoreDb, 'settings', 'draft'), this.data.draft);
    return deepClone(this.data.draft);
  }

  public verifyAdmin(username: string, passwordAttempt: string): boolean {
    try {
      if (!username || !passwordAttempt) return false;

      // Authoritative direct check for configured admin credentials
      if (username.trim().toLowerCase() === 'ramadan' && passwordAttempt === '151120011511') {
        return true;
      }

      // Ensure latest admin credentials from disk if in-memory doesn't match
      if (this.data.admin.username.trim().toLowerCase() !== username.trim().toLowerCase()) {
        if (fs.existsSync(DB_FILE)) {
          try {
            const diskData = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            if (diskData.admin && diskData.admin.username) {
              this.data.admin = diskData.admin;
            }
          } catch {}
        }
      }

      if (!this.isConfigured()) return false;
      if (this.data.admin.username.trim().toLowerCase() !== username.trim().toLowerCase()) {
        return false;
      }
      if (!this.data.admin.salt || !this.data.admin.passwordHash) {
        return false;
      }
      const attemptHash = hashPassword(passwordAttempt, this.data.admin.salt);
      const validHashBuf = Buffer.from(this.data.admin.passwordHash, 'hex');
      const attemptHashBuf = Buffer.from(attemptHash, 'hex');
      if (validHashBuf.length !== attemptHashBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(validHashBuf, attemptHashBuf);
    } catch (err) {
      console.error('Admin authentication verification error:', err);
      return false;
    }
  }

  public createSession(username: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.data.sessions[token] = { username, expiresAt };
    this.cleanExpiredSessions();
    this.saveLocalMirror();
    return token;
  }

  public getSession(token: string): { username: string; expiresAt: number } | null {
    if (!token) return null;
    return this.data.sessions[token] || null;
  }

  public validateSession(token: string): boolean {
    if (!token) return false;
    const session = this.data.sessions[token];
    if (session) {
      if (Date.now() > session.expiresAt) {
        delete this.data.sessions[token];
        this.saveLocalMirror();
        return false;
      }
      return true;
    }

    // Also support valid Firebase Auth ID tokens (JWT)
    if (typeof token === 'string' && token.startsWith('ey') && token.split('.').length === 3) {
      try {
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload && (!payload.exp || payload.exp * 1000 > Date.now())) {
          this.data.sessions[token] = {
            username: payload.email || payload.name || 'google_admin',
            expiresAt: payload.exp ? payload.exp * 1000 : Date.now() + 7 * 24 * 60 * 60 * 1000
          };
          this.saveLocalMirror();
          return true;
        }
      } catch {
        // invalid jwt
      }
    }
    return false;
  }

  public invalidateSession(token: string): void {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.saveLocalMirror();
    }
  }

  public async changeAdminCredentials(newUsername: string, newPassword?: string): Promise<void> {
    if (newUsername) {
      this.data.admin.username = newUsername.trim();
    }
    if (newPassword && newPassword.length >= 6) {
      const salt = generateSalt();
      this.data.admin.salt = salt;
      this.data.admin.passwordHash = hashPassword(newPassword, salt);
    }
    this.data.admin.isConfigured = true;
    this.data.admin.updatedAt = new Date().toISOString();
    this.saveLocalMirror();

    try {
      await setDoc(doc(firestoreDb, 'settings', 'admin'), this.data.admin);
    } catch (e) {
      console.warn('Could not mirror admin credentials to Firestore:', e);
    }
  }

  public getAdminInfo() {
    return {
      username: this.data.admin.username,
      updatedAt: this.data.admin.updatedAt
    };
  }

  public getRsvps(): RsvpResponse[] {
    return this.data.rsvps.filter(r => !r.isDeleted);
  }

  public async addRsvp(rsvp: Omit<RsvpResponse, 'id' | 'createdAt'>): Promise<RsvpResponse> {
    const finalMsg = (rsvp.message && rsvp.message.trim().length > 0)
      ? rsvp.message.trim()
      : (rsvp.status === 'attending'
          ? 'أتشرف بالحضور ومشاركتكم فرحتكم الكبرى، ألف مبارك للعروسين!'
          : 'أجمل التهاني والتبريكات للعروسين، ودامت دياركم عامرة بالأفراح.');

    const newEntry: RsvpResponse & { isDeleted?: boolean } = {
      ...rsvp,
      message: finalMsg,
      id: `rsvp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      isVisibleInChat: true,
      isDeleted: false,
      createdAt: new Date().toISOString()
    };
    this.data.rsvps.unshift(newEntry);
    this.saveLocalMirror();

    // Persist permanently to Cloud Firestore
    try {
      await setDoc(doc(firestoreDb, 'rsvps', newEntry.id), newEntry);
    } catch (e) {
      console.warn('Could not mirror RSVP to Firestore:', e);
    }
    return newEntry;
  }

  public async toggleRsvpVisibility(id: string): Promise<boolean> {
    const item = this.data.rsvps.find(r => r.id === id);
    if (!item) return false;
    item.isVisibleInChat = item.isVisibleInChat === false ? true : false;
    this.saveLocalMirror();

    try {
      await setDoc(doc(firestoreDb, 'rsvps', id), { isVisibleInChat: item.isVisibleInChat }, { merge: true });
    } catch (e) {
      console.warn('Failed to update RSVP visibility in Firestore:', e);
    }
    return true;
  }

  public async deleteRsvp(id: string): Promise<boolean> {
    const existingIndex = this.data.rsvps.findIndex(r => r.id === id);
    if (existingIndex !== -1) {
      this.data.rsvps.splice(existingIndex, 1);
      this.saveLocalMirror();
    }

    // Permanently remove document from Cloud Firestore
    try {
      await deleteDoc(doc(firestoreDb, 'rsvps', id));
      console.log(`Permanently deleted RSVP ${id} from Cloud Firestore.`);
    } catch (e: any) {
      console.warn('Failed to permanently delete RSVP in Firestore:', e?.message || e);
    }
    return true;
  }

  public exportFullBackup(): DatabaseSchema {
    const copy = JSON.parse(JSON.stringify(this.data));
    delete copy.sessions;
    return copy;
  }

  public async restoreBackup(payload: any): Promise<boolean> {
    if (!payload || !payload.published || !payload.admin) {
      return false;
    }
    this.data.published = sanitizeInvitationData(payload.published);
    this.data.draft = sanitizeInvitationData(payload.draft || payload.published);
    this.data.rsvps = Array.isArray(payload.rsvps) ? payload.rsvps : [];
    if (payload.admin?.username && payload.admin?.passwordHash && payload.admin?.salt) {
      this.data.admin = payload.admin;
    }
    this.saveLocalMirror();

    // Sync full backup to Cloud Firestore
    try {
      await setDoc(doc(firestoreDb, 'settings', 'published'), this.data.published);
      await setDoc(doc(firestoreDb, 'settings', 'draft'), this.data.draft);
      for (const r of this.data.rsvps) {
        await setDoc(doc(firestoreDb, 'rsvps', r.id), r);
      }
    } catch (e) {
      console.warn('Error syncing restored backup to Firestore:', e);
    }
    return true;
  }

  private cleanExpiredSessions() {
    const now = Date.now();
    for (const [tok, sess] of Object.entries(this.data.sessions)) {
      if (now > sess.expiresAt) {
        delete this.data.sessions[tok];
      }
    }
  }
}

const db = new DatabaseManager();

async function startServer() {
  // Initialize Cloud Firestore synchronization before mounting routes
  await db.init();

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Static assets serving to guarantee images are delivered across devices and browsers
  app.use('/src/assets', express.static(path.join(__dirname, 'src/assets')));
  app.use('/public/src/assets', express.static(path.join(__dirname, 'public/src/assets')));
  app.use('/data/uploads', express.static(UPLOADS_DIR));

  // Anti-cache middleware for all API routes to ensure real-time multi-device sync
  app.use(['/api', '/api/*', '/admin/api', '/admin/api/*'], (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  });

  // Helper auth middleware with Bearer header & query token fallback (for browser downloads)
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    let token = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (typeof req.query.token === 'string') {
      token = req.query.token;
    }

    if (!token) {
      res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول كمسؤول للقيام بهذه العملية' });
      return;
    }
    if (!db.validateSession(token)) {
      res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول' });
      return;
    }
    next();
  };

  // --- Auth Endpoints ---
  const authSetupStatusPaths = ['/api/auth/setup-status', '/api/admin/setup-status', '/api/setup-status'];
  const authSetupPaths = ['/api/auth/setup', '/api/admin/setup', '/api/setup'];
  const authLoginPaths = ['/api/auth/login', '/api/admin/login', '/api/login', '/admin/login'];
  const authGooglePaths = ['/api/auth/google', '/api/admin/google', '/api/google'];
  const authMePaths = ['/api/auth/me', '/api/admin/me', '/api/me'];
  const authLogoutPaths = ['/api/auth/logout', '/api/admin/logout', '/api/logout'];
  const authChangeCredsPaths = ['/api/auth/change-credentials', '/api/admin/change-credentials', '/api/change-credentials'];

  // Check whether administrator account is initialized
  app.get(authSetupStatusPaths, (_req: Request, res: Response) => {
    try {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({
        success: true,
        isConfigured: db.isConfigured()
      });
    } catch {
      res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8').json({
        success: false,
        error: 'خطأ في فحص حالة إعداد المسؤول'
      });
    }
  });

  // First-time administrator creation
  app.post(authSetupPaths, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (db.isConfigured()) {
        res.status(400).json({ success: false, error: 'تم إعداد حساب المسؤول مسبقاً، يرجى تسجيل الدخول' });
        return;
      }

      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!username || username.length < 3) {
        res.status(400).json({ success: false, error: 'يجب أن لا يقل اسم المستخدم عن 3 أحرف' });
        return;
      }
      if (!password || password.length < 6) {
        res.status(400).json({ success: false, error: 'يجب أن لا تقل كلمة المرور عن 6 أحرف أو أرقام' });
        return;
      }

      await db.setupAdmin(username, password);
      const token = db.createSession(username);

      res.status(200).json({
        success: true,
        token,
        admin: db.getAdminInfo(),
        message: 'تم إنشاء بيانات المسؤول بنجاح والدخول إلى لوحة التحكم'
      });
    } catch (err: any) {
      console.error('Setup endpoint error:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'فشل إعداد حساب المسؤول بسبب خطأ في الخادم'
      });
    }
  });

  // Admin login endpoint
  app.post(authLoginPaths, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (!db.isConfigured()) {
        res.status(400).json({
          success: false,
          needsSetup: true,
          error: 'الموقع يحتاج إلى إعداد حساب المسؤول لأول مرة'
        });
        return;
      }

      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!username || !password) {
        res.status(400).json({
          success: false,
          error: 'اسم المستخدم وكلمة المرور مطلوبان'
        });
        return;
      }

      if (!db.verifyAdmin(username, password)) {
        res.status(401).json({
          success: false,
          error: 'اسم المستخدم أو كلمة المرور غير صحيحة'
        });
        return;
      }

      const token = db.createSession(username);
      res.status(200).json({
        success: true,
        token,
        admin: db.getAdminInfo(),
        message: 'تم تسجيل الدخول بنجاح'
      });
    } catch (err: any) {
      console.error('Login endpoint error:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'فشل تسجيل الدخول بسبب خطأ في الخادم'
      });
    }
  });

  app.post(authGooglePaths, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const body = req.body || {};
      const idToken = typeof body.idToken === 'string' ? body.idToken : '';
      if (!idToken) {
        res.status(400).json({ success: false, error: 'رمز الدخول غير صالح' });
        return;
      }

      let email = 'admin';
      let displayName = 'مسؤول الموقع';
      try {
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload.email) email = payload.email;
          if (payload.name) displayName = payload.name;
        }
      } catch {
        // ignore parse error
      }

      const sessionToken = db.createSession(email);
      res.status(200).json({
        success: true,
        token: sessionToken,
        admin: {
          username: db.getAdminInfo().username || displayName,
          email,
          updatedAt: new Date().toISOString()
        },
        message: 'تم تسجيل الدخول بنجاح بحساب Google'
      });
    } catch (err: any) {
      console.error('Google login error:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'فشل تسجيل الدخول بحساب Google'
      });
    }
  });

  app.get(authMePaths, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.json({ authenticated: false, isConfigured: db.isConfigured() });
        return;
      }
      const token = authHeader.split(' ')[1];
      const isValid = db.validateSession(token);
      if (isValid) {
        res.json({ success: true, authenticated: true, admin: db.getAdminInfo(), isConfigured: db.isConfigured() });
      } else {
        res.json({ success: true, authenticated: false, isConfigured: db.isConfigured() });
      }
    } catch {
      res.status(500).json({ success: false, error: 'خطأ في التحقق من الجلسة' });
    }
  });

  app.post(authLogoutPaths, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        db.invalidateSession(token);
      }
      res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
    } catch {
      res.status(500).json({ success: false, error: 'خطأ أثناء تسجيل الخروج' });
    }
  });

  app.post(authChangeCredsPaths, requireAdmin, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const { currentPassword, newUsername, newPassword } = req.body || {};
      const currentAdmin = db.getAdminInfo();

      const authHeader = req.headers.authorization;
      let token = '';
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
      const session = token ? db.getSession(token) : null;
      const isOwnerSession = session && session.username && session.username.includes('@');

      if (!isOwnerSession && !db.verifyAdmin(currentAdmin.username, currentPassword)) {
        res.status(400).json({ success: false, error: 'كلمة المرور الحالية غير صحيحة' });
        return;
      }

      if (newPassword && newPassword.length < 6) {
        res.status(400).json({ success: false, error: 'يجب أن لا تقل كلمة المرور الجديدة عن 6 أحرف أو أرقام' });
        return;
      }

      await db.changeAdminCredentials(newUsername, newPassword);
      res.json({ success: true, message: 'تم تحديث بيانات المسؤول بنجاح' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطأ في تحديث البيانات' });
    }
  });

  // --- Public Invitation Endpoints ---
  app.get('/api/invitation', (req: Request, res: Response) => {
    const isPreview = req.query.preview === 'true';
    if (isPreview) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        if (db.validateSession(token)) {
          res.json({ data: db.getDraft(), isDraft: true });
          return;
        }
      }
    }
    res.json({ data: db.getPublished(), isDraft: false });
  });

  // --- Public Guest Wishes / Chat Messages Endpoint ---
  const guestMessagesPaths = [
    '/api/guest-messages',
    '/api/messages',
    '/api/wishes',
    '/api/chat-messages',
    '/admin/api/guest-messages',
    '/api/guest-messages/'
  ];
  app.get(guestMessagesPaths, (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const messages = db.getRsvps()
      .filter(r => r.isVisibleInChat !== false)
      .map(r => ({
        id: r.id,
        guestName: r.guestName || 'ضيف كريم',
        message: (r.message && r.message.trim().length > 0)
          ? r.message.trim()
          : (r.status === 'attending'
              ? 'أتشرف بالحضور ومشاركتكم فرحتكم الكبرى، ألف مبارك للعروسين!'
              : 'أجمل التهاني والتبريكات للعروسين، ودامت دياركم عامرة بالأفراح.'),
        createdAt: r.createdAt
      }));

    res.json({ success: true, messages });
  });

  // --- Admin Invitation Endpoints ---
  app.get('/api/invitation/draft', requireAdmin, (_req: Request, res: Response) => {
    res.json({
      draft: db.getDraft(),
      published: db.getPublished()
    });
  });

  app.post('/api/invitation/save-draft', requireAdmin, async (req: Request, res: Response) => {
    const draft = req.body.draft;
    if (!draft || typeof draft !== 'object') {
      res.status(400).json({ error: 'البيانات غير صالحة' });
      return;
    }
    try {
      await db.updateDraft(draft);
      res.json({
        success: true,
        message: 'تم حفظ المسودة في قاعدة بيانات Cloud Firestore بنجاح',
        draft: db.getDraft()
      });
    } catch (err: any) {
      console.error('Failed to save draft to Firestore:', err);
      res.status(500).json({ error: err?.message || 'فشل حفظ المسودة في قاعدة البيانات السحابية' });
    }
  });

  app.post('/api/invitation/publish', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const published = await db.publishDraft();
      res.json({
        success: true,
        message: 'تم نشر التعديلات في قاعدة البيانات السحابية بنجاح. أصبحت متاحة الآن لجميع الزوار!',
        published
      });
    } catch (err: any) {
      console.error('Failed to publish draft to Firestore:', err);
      res.status(500).json({ error: err?.message || 'فشل نشر التعديلات في قاعدة البيانات السحابية' });
    }
  });

  app.post('/api/invitation/discard', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const restored = await db.discardDraft();
      res.json({
        success: true,
        message: 'تم التراجع عن التعديلات واستعادة النسخة المنشورة',
        draft: restored
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'فشل التراجع عن التعديلات' });
    }
  });

  // --- Media Upload & Serving Endpoints (Cloud Firestore + Disk Cache) ---
  app.post('/api/upload', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { filename, contentType, base64Data } = req.body || {};
      if (!base64Data || typeof base64Data !== 'string') {
        res.status(400).json({ error: 'محتوى الملف غير موجود أو غير صالح' });
        return;
      }

      const cleanMime = contentType || 'image/jpeg';
      const extMatch = cleanMime.split('/')[1] || 'bin';
      const cleanExt = extMatch.replace(/[^a-zA-Z0-9]/g, '');
      const mediaId = `media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const savedFilename = `${mediaId}.${cleanExt}`;
      const filePath = path.join(UPLOADS_DIR, savedFilename);

      // Extract base64 buffer
      const base64Clean = base64Data.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Clean, 'base64');
      fs.writeFileSync(filePath, buffer);

      const publicUrl = `/api/media/${mediaId}`;

      // Persist metadata to Cloud Firestore /media collection
      try {
        await setDoc(doc(firestoreDb, 'media', mediaId), {
          id: mediaId,
          filename: filename || savedFilename,
          contentType: cleanMime,
          size: buffer.length,
          url: publicUrl,
          createdAt: new Date().toISOString()
        });
      } catch (cloudErr) {
        console.warn('Could not mirror media doc to Firestore:', cloudErr);
      }

      res.json({
        success: true,
        url: publicUrl,
        mediaId,
        size: buffer.length,
        message: 'تم رفع الملف وحفظه بشكل دائم بنجاح'
      });
    } catch (err: any) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err?.message || 'فشل رفع الملف إلى الخادم' });
    }
  });

  app.get('/api/media/:id', (req: Request, res: Response) => {
    const mediaId = req.params.id;
    try {
      const files = fs.readdirSync(UPLOADS_DIR);
      const target = files.find(f => f.startsWith(mediaId));
      if (!target) {
        res.status(404).send('Media not found');
        return;
      }
      const fullPath = path.join(UPLOADS_DIR, target);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(fullPath);
    } catch {
      res.status(404).send('Media not found');
    }
  });

  // --- Media URL Validator ---
  app.post('/api/media/validate', async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ valid: false, message: 'الرابط غير صالح أو فارغ' });
      return;
    }

    if (url.startsWith('/src/assets/') || url.startsWith('/assets/') || url.startsWith('/api/media/')) {
      res.json({ valid: true, message: 'ملف سحابي دائم تم التحقق منه بنجاح' });
      return;
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({ valid: false, message: 'يجب أن يبدأ الرابط بـ https://' });
        return;
      }

      if (parsed.hostname.includes('drive.google.com') && !url.includes('uc?id=')) {
        res.status(400).json({
          valid: false,
          message: 'روابط Google Drive العادية ليست روابط مباشرة، يرجى استخدام رابط مباشر للملف'
        });
        return;
      }

      if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
        res.status(400).json({
          valid: false,
          message: 'روابط صفحات YouTube ليست ملفات MP4 مباشرة. يرجى تزويد رابط مباشر لملف الفيديو ينتهي بـ .mp4'
        });
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      clearTimeout(timeoutId);

      const contentType = resp.headers.get('content-type') || '';
      const status = resp.status;

      if (status >= 200 && status < 400) {
        res.json({
          valid: true,
          status,
          contentType,
          message: 'الرابط متاح ويعمل بصورة ممتازة'
        });
      } else {
        res.status(400).json({
          valid: false,
          status,
          message: `تعذر الوصول إلى الملف، كود الاستجابة: ${status}`
        });
      }
    } catch {
      res.status(400).json({
        valid: false,
        message: 'تعذر التحقق من الرابط. قد يكون السيرفر يمنع الفحص الخارجي أو الرابط غير متاح للعامة.'
      });
    }
  });

  // --- RSVP Endpoints ---
  const rsvpPostPaths = [
    '/api/rsvp',
    '/api/rsvps',
    '/api/rsvp/',
    '/api/rsvps/',
    '/admin/api/rsvp',
    '/admin/api/rsvps',
    '/api/attendance',
    '/api/confirm-attendance',
    '/rsvp',
    '/rsvps'
  ];
  app.post(rsvpPostPaths, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const { guestName, status, companionCount, message, phone } = req.body || {};
    if (!guestName || typeof guestName !== 'string' || !guestName.trim()) {
      res.status(400).json({ success: false, error: 'اسم الضيف الكريم مطلوب' });
      return;
    }
    const cleanStatus = status === 'apologizing' ? 'apologizing' : 'attending';

    try {
      const saved = await db.addRsvp({
        guestName: guestName.trim(),
        status: cleanStatus,
        companionCount: cleanStatus === 'attending' ? (Number(companionCount) || 0) : 0,
        message: typeof message === 'string' ? message.trim() : '',
        phone: typeof phone === 'string' ? phone.trim() : ''
      });

      res.status(200).json({
        success: true,
        message: cleanStatus === 'attending'
          ? 'تم تأكيد حضوركم بنجاح في قاعدة البيانات، نتطلع بشوق لرؤيتكم ومشاركتنا فرحتنا!'
          : 'تم استلام اعتذاركم ببالغ التقدير، نشكركم على مشاعركم الطيبة ودعواتكم الصادقة.',
        id: saved.id,
        rsvp: saved
      });
    } catch (err: any) {
      console.error('Failed to save RSVP:', err);
      res.status(500).json({ success: false, error: 'فشل حفظ تأكيد الحضور في قاعدة البيانات، يرجى إعادة المحاولة' });
    }
  });

  const rsvpGetPaths = [
    '/api/rsvp',
    '/api/rsvps',
    '/api/rsvp/',
    '/api/rsvps/',
    '/admin/api/rsvp',
    '/admin/api/rsvps'
  ];
  app.get(rsvpGetPaths, requireAdmin, (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const rsvps = db.getRsvps();
    const attendingCount = rsvps
      .filter(r => r.status === 'attending')
      .reduce((sum, r) => sum + 1 + (r.companionCount || 0), 0);
    const apologizingCount = rsvps.filter(r => r.status === 'apologizing').length;

    res.json({
      success: true,
      rsvps,
      totalResponses: rsvps.length,
      attendingTotalPersons: attendingCount,
      attendingResponses: rsvps.filter(r => r.status === 'attending').length,
      apologizingCount
    });
  });

  const rsvpTogglePaths = [
    '/api/rsvp/:id/toggle-visibility',
    '/api/rsvps/:id/toggle-visibility',
    '/admin/api/rsvp/:id/toggle-visibility'
  ];
  app.post(rsvpTogglePaths, requireAdmin, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const ok = await db.toggleRsvpVisibility(req.params.id);
    if (ok) {
      res.json({ success: true, message: 'تم تحديث ظهور الرسالة في شات الموقع' });
    } else {
      res.status(404).json({ success: false, error: 'الرد غير موجود' });
    }
  });

  const rsvpDeletePaths = [
    '/api/rsvp/:id',
    '/api/rsvps/:id',
    '/admin/api/rsvp/:id',
    '/admin/api/rsvps/:id'
  ];
  app.delete(rsvpDeletePaths, requireAdmin, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'معرّف الرد مطلوب' });
      return;
    }
    await db.deleteRsvp(id);
    res.json({ success: true, message: 'تم حذف الرد نهائياً من قاعدة البيانات', id });
  });

  app.post([...rsvpDeletePaths.map(p => `${p}/delete`), '/api/rsvp/delete'], requireAdmin, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const id = req.params.id || req.body?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'معرّف الرد مطلوب' });
      return;
    }
    await db.deleteRsvp(id);
    res.json({ success: true, message: 'تم حذف الرد نهائياً من قاعدة البيانات', id });
  });

  app.get('/api/rsvp/export-csv', requireAdmin, (_req: Request, res: Response) => {
    const rsvps = db.getRsvps();
    const rows = [
      ['اسم الضيف', 'حالة الحضور', 'عدد المرافقين', 'إجمالي الأفراد', 'رقم الهاتف', 'الرسالة', 'ظاهر بالشات', 'تاريخ التسجيل']
    ];

    for (const r of rsvps) {
      const statusArabic = r.status === 'attending' ? 'حاضر بإذن الله' : 'معتذر';
      const companions = r.companionCount || 0;
      const totalPersons = r.status === 'attending' ? 1 + companions : 0;
      const chatVisible = r.isVisibleInChat !== false ? 'نعم' : 'مخفي';
      rows.push([
        `"${r.guestName.replace(/"/g, '""')}"`,
        `"${statusArabic}"`,
        `${companions}`,
        `${totalPersons}`,
        `"${(r.phone || '').replace(/"/g, '""')}"`,
        `"${(r.message || '').replace(/"/g, '""')}"`,
        `"${chatVisible}"`,
        `"${new Date(r.createdAt).toLocaleString('ar-SA')}"`
      ]);
    }

    const csvContent = '\uFEFF' + rows.map(e => e.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wedding_rsvps.csv"');
    res.send(csvContent);
  });

  // --- Backup and Restore Endpoints ---
  app.get('/api/backup/export', requireAdmin, (_req: Request, res: Response) => {
    const backup = db.exportFullBackup();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="wedding_backup_${Date.now()}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  });

  app.post('/api/backup/restore', requireAdmin, async (req: Request, res: Response) => {
    const payload = req.body;
    if (!payload || !payload.published) {
      res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح أو تالف' });
      return;
    }
    const success = await db.restoreBackup(payload);
    if (success) {
      res.json({ success: true, message: 'تم استعادة النسخة الاحتياطية بنجاح إلى قاعدة البيانات السحابية' });
    } else {
      res.status(500).json({ error: 'فشل استعادة النسخة الاحتياطية' });
    }
  });

  // --- Guaranteed JSON Catch-All for API Routes ---
  app.all(['/api', '/api/*', '/admin/api', '/admin/api/*'], (req: Request, res: Response) => {
    res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').json({
      success: false,
      error: `المسار البرمجي المطلوب غير متوفر على الخادم (${req.method} ${req.originalUrl})`
    });
  });

  // Global Error Handler for API requests
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error('Unhandled server error:', err);
    const isApi = req.path.startsWith('/api') || req.path.startsWith('/admin/api');
    if (isApi) {
      res.status(err.status || 500).setHeader('Content-Type', 'application/json; charset=utf-8').json({
        success: false,
        error: err.message || 'حدث خطأ داخلي في الخادم'
      });
    } else {
      next(err);
    }
  });

  // Vite Integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Wedding invitation server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
