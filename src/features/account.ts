import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getKuGouLibrarySyncStatus, getKuGouLoginStatus, loginKuGouCellphone, logoutKuGou, sendKuGouCaptcha, syncKuGouLibrary } from "../api";
import type { KuGouLibrarySyncStatus, KuGouLoginAccount, KuGouLoginStatus } from "../types";

/** Library is re-synced automatically when the last sync is older than this. */
export const LIBRARY_STALE_MS = 6 * 60 * 60 * 1000;

export function isLibraryStale(status: KuGouLibrarySyncStatus | null, now: number): boolean {
  if (!status?.syncedAt) return true;
  const syncedAt = new Date(status.syncedAt).getTime();
  return !Number.isFinite(syncedAt) || now - syncedAt > LIBRARY_STALE_MS;
}

export interface KuGouAccount {
  readonly loginStatus: KuGouLoginStatus | null;
  readonly libraryStatus: KuGouLibrarySyncStatus | null;
  readonly mobile: string;
  readonly code: string;
  readonly accounts: KuGouLoginAccount[];
  readonly selectedUserId: string;
  readonly busy: boolean;
  readonly syncing: boolean;
  setMobile(value: string): void;
  setCode(value: string): void;
  selectUser(userid: string): void;
  sendCaptcha(): void;
  login(): void;
  logout(): void;
}

/**
 * Provider account: login (captcha, multi-account choice), logout, library
 * sync (automatic when stale). It never changes playback; the server revokes
 * stream handles on account changes and the core re-resolves when needed.
 */
export function useKuGouAccount(options: { readonly onLibraryChanged: () => void; readonly setStatus: (message: string) => void }): KuGouAccount {
  const { onLibraryChanged, setStatus } = options;
  const [loginStatus, setLoginStatus] = useState<KuGouLoginStatus | null>(null);
  const [libraryStatus, setLibraryStatus] = useState<KuGouLibrarySyncStatus | null>(null);
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [accounts, setAccounts] = useState<KuGouLoginAccount[]>([]);
  const [selectedUserId, selectUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sync = useCallback(
    async (silent: boolean) => {
      setSyncing(true);
      if (!silent) setStatus("正在同步酷狗歌单与歌曲索引。");
      try {
        const result = await syncKuGouLibrary();
        if (!mounted.current) return;
        setLibraryStatus(result);
        onLibraryChanged();
        setStatus(`酷狗曲库已同步：${result.playlistCount} 个歌单，${result.trackCount} 首去重歌曲；新增 ${result.added}，更新 ${result.updated}，移除 ${result.removed}。`);
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof ApiError && error.needsLogin) {
          setLoginStatus({ loggedIn: false, needsLogin: true, reason: "expired" });
          setStatus("酷狗登录已过期，请重新获取验证码登录。");
          return;
        }
        setStatus(error instanceof Error ? error.message : "酷狗曲库同步失败。");
      } finally {
        if (mounted.current) setSyncing(false);
      }
    },
    [onLibraryChanged, setStatus]
  );

  useEffect(() => {
    let cancelled = false;
    getKuGouLoginStatus()
      .then(async (login) => {
        if (cancelled) return;
        setLoginStatus(login);
        if (!login.loggedIn) return;
        const status = await getKuGouLibrarySyncStatus();
        if (cancelled) return;
        setLibraryStatus(status);
        if (isLibraryStale(status, Date.now())) await sync(true);
      })
      .catch(() => {
        if (!cancelled) setLoginStatus({ loggedIn: false, needsLogin: false, reason: "status_unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [sync]);

  const sendCaptcha = useCallback(() => {
    setBusy(true);
    setStatus("正在发送酷狗验证码。");
    sendKuGouCaptcha(mobile.trim())
      .then(() => setStatus("验证码已发送。"))
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : "验证码发送失败。"))
      .finally(() => mounted.current && setBusy(false));
  }, [mobile, setStatus]);

  const login = useCallback(() => {
    setBusy(true);
    setStatus("正在登录酷狗。");
    loginKuGouCellphone({ mobile: mobile.trim(), code: code.trim(), userid: selectedUserId || undefined })
      .then(async (result) => {
        if (!mounted.current) return;
        if (!result.ok) {
          if (result.requiresAccountSelection && result.accounts?.length) {
            setAccounts(result.accounts);
            selectUser(result.accounts[0]?.userid ?? "");
            setStatus("这个手机号绑定了多个酷狗账号，请选择一个后再次登录。");
            return;
          }
          setStatus(result.error ?? "酷狗登录失败。");
          return;
        }
        setLoginStatus(result.status);
        setAccounts([]);
        selectUser("");
        setStatus("酷狗已登录，正在同步曲库。");
        await sync(false);
      })
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : "酷狗登录失败。"))
      .finally(() => mounted.current && setBusy(false));
  }, [code, mobile, selectedUserId, setStatus, sync]);

  const logout = useCallback(() => {
    setBusy(true);
    logoutKuGou()
      .then((status) => {
        if (!mounted.current) return;
        setLoginStatus(status);
        setLibraryStatus(null);
        setAccounts([]);
        selectUser("");
        setStatus("已退出酷狗，可以重新登录。");
      })
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : "退出酷狗失败。"))
      .finally(() => mounted.current && setBusy(false));
  }, [setStatus]);

  return { loginStatus, libraryStatus, mobile, code, accounts, selectedUserId, busy, syncing, setMobile, setCode, selectUser, sendCaptcha, login, logout };
}
