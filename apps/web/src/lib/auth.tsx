import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnect, useDisconnect, useSignMessage } from 'wagmi';
import { DEFAULT_CHAIN, MOCK, STORAGE, type Chain } from '../config';
import * as api from './api';
import { mockSession } from './mock';
import { errorMessage, useToast } from './toast';
import type { Session } from './types';
import { getSolanaAdapters, solanaSign } from './wallets';

/**
 * Session persistence. The JWT itself lives in the gateway's HttpOnly `mesh_session` cookie, which
 * page scripts cannot read, so XSS cannot lift it. localStorage keeps only a hint ({wallet, chain},
 * no token) so the UI renders signed-in immediately on reload; GET /auth/session then confirms or
 * clears it. Entries written by older builds (JWT included) are migrated: the token is used once to
 * mint the cookie via /auth/refresh and then dropped.
 */
interface StoredHint {
  wallet: string;
  chain: string;
  /** Legacy builds stored the JWT here; current builds never write it. */
  token?: string;
}

function loadHint(): StoredHint | null {
  try {
    const raw = localStorage.getItem(STORAGE.session);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredHint>;
    if (!s?.wallet) return null;
    if (s.token && !MOCK && jwtExpired(s.token)) return null;
    return { wallet: s.wallet, chain: s.chain ?? DEFAULT_CHAIN, token: s.token };
  } catch {
    return null;
  }
}

function jwtExpired(token: string): boolean {
  const [, payload] = token.split('.');
  if (!payload) return false;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return Boolean(claims.exp && claims.exp * 1000 < Date.now());
  } catch {
    return false; // mock / opaque token
  }
}

function saveHint(s: Session | null) {
  try {
    // Never persist the token: mock sessions carry a fake one, real ones carry the cookie sentinel.
    if (s) localStorage.setItem(STORAGE.session, JSON.stringify({ wallet: s.wallet, chain: s.chain }));
    else localStorage.removeItem(STORAGE.session);
  } catch {
    /* storage blocked: the cookie alone carries the session; the hint is a convenience */
  }
}

/** The session as the app sees it after a cookie sign-in: the token column holds the cookie sentinel. */
const cookieSession = (wallet: string, chain: string): Session => ({ token: api.COOKIE_SESSION, wallet, chain });

type Status = 'idle' | 'connecting' | 'signing' | 'verifying';

interface AuthApi {
  session: Session | null;
  token: string | null;
  status: Status;
  chain: Chain;
  setChain: (c: Chain) => void;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  /**
   * Public beta: the gateway answered `403 invite_required` for the wallet that just signed. The modal
   * shows the invite field; the next sign-in attempt sends `invite` along with the signature.
   */
  inviteNeeded: boolean;
  invite: string;
  setInvite: (code: string) => void;
  signInSolana: (adapterName: string) => Promise<void>;
  signInEvm: (connectorId: string) => Promise<void>;
  signInMock: () => Promise<void>;
  signOut: () => void;
  /** Call when a request returned 401: drops the session and asks the user to sign in again. */
  expire: () => void;
  /**
   * Signs an arbitrary message with the signed-in wallet (same wallet as `session.wallet`): Phantom/Solflare
   * `signMessage` → base58, or EIP-191 `personal_sign` via wagmi. Used to link a Mac (POST /nodes/link).
   */
  signMessage: (message: string) => Promise<{ signature: string; chain: Chain }>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(() => {
    const hint = loadHint();
    if (!hint) return null;
    // Mock mode keeps its fake token; real mode always goes through the cookie.
    return MOCK ? { token: hint.token ?? 'mock.jwt.token', wallet: hint.wallet, chain: hint.chain } : cookieSession(hint.wallet, hint.chain);
  });
  const [status, setStatus] = useState<Status>('idle');
  const [chain, setChain] = useState<Chain>(DEFAULT_CHAIN);
  const [modalOpen, setModalOpen] = useState(false);
  const [inviteNeeded, setInviteNeeded] = useState(false);
  const [invite, setInvite] = useState('');
  const inviteRef = useRef(invite);
  inviteRef.current = invite;

  const { connectAsync, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();

  useEffect(() => saveHint(session), [session]);

  // Boot: confirm the cookie session (or migrate a legacy localStorage JWT into a cookie once).
  useEffect(() => {
    if (MOCK) return;
    let cancelled = false;
    (async () => {
      const hint = loadHint();
      try {
        if (hint?.token) {
          // Legacy entry: the bearer mints the cookie pair, then the token is forgotten.
          const res = await api.refreshSession(hint.token);
          if (!cancelled) setSession(cookieSession(res.wallet, res.chain));
          return;
        }
        const who = await api.getSession();
        if (!cancelled) setSession(cookieSession(who.wallet, who.chain));
      } catch (err) {
        // 401 = not signed in (or expired): drop the hint. Network errors keep whatever we had.
        if (!cancelled && err instanceof api.ApiError && err.status === 401) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Let the API layer refresh the session token once on a 401 (POST /auth/refresh) and retry.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    api.registerSessionStore({
      getToken: () => sessionRef.current?.token ?? null,
      setToken: (token) => setSession((s) => (s ? { ...s, token } : s)),
    });
    return () => api.registerSessionStore(null);
  }, []);

  const finish = useCallback(
    (s: Session) => {
      setSession(s);
      setStatus('idle');
      setModalOpen(false);
      setInviteNeeded(false);
      setInvite('');
    },
    [],
  );

  const fail = useCallback(
    (err: unknown) => {
      setStatus('idle');
      const msg = errorMessage(err);
      // Beta gate: not an error, a missing (or wrong) invite code. Keep the modal open with the field showing.
      if (err instanceof api.ApiError && (err.code === 'invite_required' || err.code === 'invite_invalid')) {
        setInviteNeeded(true);
        if (err.code === 'invite_required') toast.info('Mesh is in beta: enter your invite code and sign again');
        else toast.error(msg);
        return;
      }
      // User-cancelled signatures are not errors worth shouting about.
      if (/reject|denied|cancel/i.test(msg)) toast.info('Signature cancelled');
      else toast.error(msg);
    },
    [toast],
  );

  const signInSolana = useCallback(
    async (adapterName: string) => {
      const adapter = getSolanaAdapters().find((a) => a.name === adapterName);
      if (!adapter) return fail(new Error(`${adapterName} is not available`));
      try {
        setStatus('connecting');
        // The wallet signs the exact message string the gateway issued; we echo it back on verify.
        let signed = '';
        const { wallet, signature } = await solanaSign(adapter, async (w) => {
          setStatus('signing');
          signed = (await api.getNonce(w)).message;
          return signed;
        });
        setStatus('verifying');
        const res = await api.verifySignature(wallet, signature, 'solana', signed, inviteRef.current);
        finish(cookieSession(res.wallet, res.chain));
      } catch (err) {
        fail(err);
      }
    },
    [fail, finish],
  );

  const signInEvm = useCallback(
    async (connectorId: string) => {
      const connector = connectors.find((c) => c.id === connectorId);
      if (!connector) return fail(new Error('Wallet not detected'));
      try {
        setStatus('connecting');
        const { accounts } = await connectAsync({ connector });
        const wallet = accounts[0];
        if (!wallet) throw new Error('No account returned');
        setStatus('signing');
        const { message } = await api.getNonce(wallet);
        const signature = await signMessageAsync({ message, account: wallet });
        setStatus('verifying');
        const res = await api.verifySignature(wallet, signature, 'evm', message, inviteRef.current);
        finish(cookieSession(res.wallet, res.chain));
      } catch (err) {
        fail(err);
      }
    },
    [connectAsync, connectors, fail, finish, signMessageAsync],
  );

  const signInMock = useCallback(async () => {
    try {
      setStatus('verifying');
      finish(await mockSession(inviteRef.current));
    } catch (err) {
      fail(err);
    }
  }, [fail, finish]);

  const signOut = useCallback(() => {
    setSession(null);
    // Clear the HttpOnly cookie server-side; JS cannot. Best effort: the UI is already signed out.
    if (!MOCK) api.logout().catch(() => undefined);
    disconnectAsync().catch(() => undefined);
    getSolanaAdapters().forEach((a) => a.connected && a.disconnect().catch(() => undefined));
  }, [disconnectAsync]);

  const expire = useCallback(() => {
    setSession(null);
    toast.info('Session expired. Sign in again.');
  }, [toast]);

  const signMessage = useCallback(
    async (message: string): Promise<{ signature: string; chain: Chain }> => {
      const s = sessionRef.current;
      if (!s) throw new Error('Connect a wallet first');
      const sessionChain: Chain = s.chain === 'evm' ? 'evm' : s.chain === 'solana' ? 'solana' : DEFAULT_CHAIN;
      if (MOCK) return { signature: `mock:${btoa(message).slice(0, 24)}`, chain: sessionChain };
      if (sessionChain === 'solana') {
        const adapters = getSolanaAdapters();
        // Prefer the adapter already connected as this wallet; otherwise connect the first available one.
        let adapter = adapters.find((a) => a.connected && a.publicKey?.toBase58() === s.wallet) ?? null;
        if (!adapter) {
          for (const a of adapters) {
            if (!a.connected) await a.connect().catch(() => undefined);
            if (a.connected && a.publicKey?.toBase58() === s.wallet) {
              adapter = a;
              break;
            }
          }
        }
        if (!adapter) throw new Error(`Open the wallet you signed in with (${s.wallet.slice(0, 4)}…${s.wallet.slice(-4)}) to sign`);
        const { signature } = await solanaSign(adapter, async () => message);
        return { signature, chain: 'solana' };
      }
      const signature = await signMessageAsync({ message, account: s.wallet as `0x${string}` });
      return { signature, chain: 'evm' };
    },
    [signMessageAsync],
  );

  const value = useMemo<AuthApi>(
    () => ({
      session,
      token: session?.token ?? null,
      status,
      chain,
      setChain,
      modalOpen,
      openModal: () => setModalOpen(true),
      closeModal: () => status === 'idle' && setModalOpen(false),
      inviteNeeded,
      invite,
      setInvite,
      signInSolana,
      signInEvm,
      signInMock,
      signOut,
      expire,
      signMessage,
    }),
    [session, status, chain, modalOpen, inviteNeeded, invite, signInSolana, signInEvm, signInMock, signOut, expire, signMessage],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
