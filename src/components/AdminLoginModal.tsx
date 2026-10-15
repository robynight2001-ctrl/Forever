import React, { useState, useEffect } from 'react';
import { X, Lock, KeyRound, User, AlertCircle, ArrowLeft, ShieldCheck, UserPlus } from 'lucide-react';
import { safeFetchJson } from '../utils/api';
import { auth, googleProvider } from '../lib/firebase';
import { signInWithPopup } from 'firebase/auth';

interface AdminLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (token: string, admin: any) => void;
}

export const AdminLoginModal: React.FC<AdminLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess
}) => {
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);

  // Form fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const formatErrorMessage = (err: any): string => {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err === 'object') {
      const code = err.code || '';
      if (code === 'auth/popup-closed-by-user') {
        return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام المصادقة';
      }
      if (code === 'auth/popup-blocked') {
        return 'تم حظر النافذة المنبثقة من قِبل المتصفح، يرجى السماح بالنوافذ المنبثقة ثم المحاولة مجدداً';
      }
      if (code === 'auth/cancelled-popup-request') {
        return 'تم إلغاء طلب تسجيل الدخول السابق';
      }
      if (code === 'auth/network-request-failed') {
        return 'تعذر الاتصال بخدمة المصادقة، يرجى التحقق من اتصال الإنترنت';
      }
      if (code === 'auth/unauthorized-domain') {
        return 'النطاق الحالي غير مصرح له في إعدادات Firebase Auth';
      }
      if (typeof err.message === 'string') return err.message;
      if (typeof err.error === 'string') return err.error;
      if (err.message && typeof err.message === 'object') return formatErrorMessage(err.message);
      return code ? `خطأ (${code})` : (JSON.stringify(err) || 'حدث خطأ أثناء تسجيل الدخول');
    }
    return String(err);
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await signInWithPopup(auth, googleProvider);
      if (res.user) {
        const idToken = await res.user.getIdToken();
        
        // Exchange or register session on server
        const sessionRes = await safeFetchJson<{ success: boolean; token: string; admin: any }>('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        });

        const activeToken = sessionRes.ok && sessionRes.data?.token ? sessionRes.data.token : idToken;
        const adminData = sessionRes.ok && sessionRes.data?.admin ? sessionRes.data.admin : {
          username: res.user.displayName || res.user.email || 'Admin',
          email: res.user.email,
          updatedAt: new Date().toISOString()
        };

        localStorage.setItem('wedding_admin_token', activeToken);
        onLoginSuccess(activeToken, adminData);
        onClose();
      }
    } catch (err: any) {
      console.error('Google sign in error:', err);
      setError(formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Check whether administrator account is configured or needs first-time setup
  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    const checkSetupStatus = async () => {
      setCheckingStatus(true);
      setError('');
      try {
        const res = await safeFetchJson<{ isConfigured: boolean }>('/api/auth/setup-status');
        if (isMounted) {
          if (res.ok && res.data) {
            setIsSetupMode(!res.data.isConfigured);
          } else {
            // Default to normal login mode if check encounters unexpected state
            setIsSetupMode(false);
          }
        }
      } catch {
        if (isMounted) setIsSetupMode(false);
      } finally {
        if (isMounted) setCheckingStatus(false);
      }
    };

    checkSetupStatus();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isSetupMode) {
      if (!username.trim() || username.trim().length < 3) {
        setError('يجب أن لا يقل اسم المستخدم عن 3 أحرف');
        return;
      }
      if (!password || password.length < 6) {
        setError('يجب أن لا تقل كلمة المرور عن 6 أحرف أو أرقام');
        return;
      }
      if (password !== confirmPassword) {
        setError('كلمة المرور وتأكيد كلمة المرور غير متطابقين');
        return;
      }

      setLoading(true);
      try {
        const res = await safeFetchJson<{ token: string; admin: any; message?: string }>('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username.trim(),
            password
          })
        });

        if (!res.ok || !res.data) {
          setError(formatErrorMessage(res.error) || 'فشل إعداد حساب المسؤول، يرجى المحاولة مرة أخرى');
          return;
        }

        localStorage.setItem('wedding_admin_token', res.data.token);
        onLoginSuccess(res.data.token, res.data.admin);
        onClose();
      } catch (err: any) {
        setError(formatErrorMessage(err));
      } finally {
        setLoading(false);
      }
    } else {
      // Normal Login
      if (!username.trim() || !password) {
        setError('يرجى إدخال اسم المستخدم وكلمة المرور');
        return;
      }

      setLoading(true);
      try {
        const res = await safeFetchJson<{ token: string; admin: any; needsSetup?: boolean }>('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username.trim(),
            password
          })
        });

        if (!res.ok || !res.data) {
          if (res.data?.needsSetup) {
            setIsSetupMode(true);
          }
          setError(formatErrorMessage(res.error) || 'اسم المستخدم أو كلمة المرور غير صحيحة');
          return;
        }

        localStorage.setItem('wedding_admin_token', res.data.token);
        onLoginSuccess(res.data.token, res.data.admin);
        onClose();
      } catch (err: any) {
        setError(formatErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#140e0b]/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="relative w-full max-w-md bg-[#231b17] border border-[#c89d5c]/50 rounded-3xl p-6 sm:p-8 shadow-2xl">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-5 left-5 text-[#8c7b70] hover:text-[#fbf7f0] p-1.5 rounded-full hover:bg-[#2c221d] transition-colors cursor-pointer"
          title="إغلاق"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center space-y-2 mb-8">
          <div className="w-12 h-12 rounded-full bg-[#c89d5c]/20 border border-[#c89d5c] text-[#c89d5c] flex items-center justify-center mx-auto mb-3">
            {isSetupMode ? <UserPlus className="w-6 h-6" /> : <Lock className="w-6 h-6" />}
          </div>
          <h2 className="text-2xl font-heading font-bold text-[#fbf7f0]">
            {isSetupMode ? 'إعداد حساب المسؤول لأول مرة' : 'تسجيل دخول المسؤول'}
          </h2>
          <p className="text-xs text-[#b09e90] leading-relaxed">
            {isSetupMode
              ? 'قم بإنشاء اسم المستخدم وكلمة المرور الخاصة بك لتأمين لوحة التحكم'
              : 'أدخل بيانات الاعتماد الخاصة بك للوصول إلى لوحة التحكم'}
          </p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-950/70 border border-red-800 text-red-200 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{typeof error === 'string' ? error : formatErrorMessage(error)}</span>
          </div>
        )}

        {checkingStatus ? (
          <div className="py-8 text-center text-xs text-[#8c7b70]">
            جاري التحقق من أمان النظام...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#d8cfc4]">
                اسم المستخدم
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="اختر اسم المستخدم"
                  className="w-full pl-4 pr-10 py-3 rounded-xl bg-[#1c1512] border border-[#4a382e] text-[#fbf7f0] placeholder-[#6e5d52] focus:outline-none focus:border-[#c89d5c] text-sm"
                />
                <User className="w-4 h-4 text-[#8c7b70] absolute right-3.5 top-3.5" />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#d8cfc4]">
                كلمة المرور
              </label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-4 pr-10 py-3 rounded-xl bg-[#1c1512] border border-[#4a382e] text-[#fbf7f0] placeholder-[#6e5d52] focus:outline-none focus:border-[#c89d5c] text-sm font-mono"
                />
                <KeyRound className="w-4 h-4 text-[#8c7b70] absolute right-3.5 top-3.5" />
              </div>
            </div>

            {isSetupMode && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#d8cfc4]">
                  تأكيد كلمة المرور
                </label>
                <div className="relative">
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-4 pr-10 py-3 rounded-xl bg-[#1c1512] border border-[#4a382e] text-[#fbf7f0] placeholder-[#6e5d52] focus:outline-none focus:border-[#c89d5c] text-sm font-mono"
                  />
                  <ShieldCheck className="w-4 h-4 text-[#8c7b70] absolute right-3.5 top-3.5" />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-4 py-3.5 rounded-xl bg-[#c89d5c] hover:bg-[#d8ad6e] text-[#140e0b] font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg hover:shadow-[#c89d5c]/30 disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <span>جاري المعالجة...</span>
              ) : isSetupMode ? (
                <>
                  <span>إنشاء الحساب ودخول لوحة التحكم</span>
                  <ArrowLeft className="w-4 h-4 text-[#140e0b]" />
                </>
              ) : (
                <>
                  <span>دخول لوحة التحكم</span>
                  <ArrowLeft className="w-4 h-4 text-[#140e0b]" />
                </>
              )}
            </button>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#3d2c23]" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-[#231b17] px-2 text-[#8c7b70]">أو الدخول المباشر للمالك</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full py-3 rounded-xl bg-[#1c1512] hover:bg-[#2c221d] text-[#fbf7f0] border border-[#4a382e] hover:border-[#c89d5c] text-xs font-semibold flex items-center justify-center gap-2.5 transition-all cursor-pointer disabled:opacity-50"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              <span>تسجيل الدخول بحساب Google (المالك)</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
