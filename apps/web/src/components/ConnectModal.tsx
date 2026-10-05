import { useEffect, useState } from 'react';
import { MOCK, TOKENOMICS } from '../config';
import { useAuth } from '../lib/auth';
import { useBeta } from '../lib/hooks';
import { EVM_WALLETS, evmInstalled, getSolanaAdapters, solanaReady } from '../lib/wallets';
import { Modal, Notice, Spinner } from './ui';

export function ConnectModal() {
  const auth = useAuth();
  const beta = useBeta();
  const [, bump] = useState(0);

  // Adapters report readiness asynchronously; re-render once they settle.
  useEffect(() => {
    if (!auth.modalOpen) return;
    const adapters = getSolanaAdapters();
    const onChange = () => bump((n) => n + 1);
    adapters.forEach((a) => a.on('readyStateChange', onChange));
    const t = window.setTimeout(onChange, 400);
    return () => {
      adapters.forEach((a) => a.off('readyStateChange', onChange));
      window.clearTimeout(t);
    };
  }, [auth.modalOpen]);

  if (!auth.modalOpen) return null;
  const busy = auth.status !== 'idle';
  const statusText =
    auth.status === 'connecting'
      ? 'Waiting for wallet…'
      : auth.status === 'signing'
        ? 'Sign the message in your wallet'
        : auth.status === 'verifying'
          ? 'Verifying…'
          : null;

  return (
    <Modal title="Sign in with a wallet" onClose={auth.closeModal}>
      <p className="small muted">
        Signing proves you hold the wallet. It costs nothing and sends no transaction. {TOKENOMICS.ticker} lives on{' '}
        <span className="mono">{TOKENOMICS.chain}</span>.
      </p>
      {auth.inviteNeeded ? (
        <div className="stack sm" aria-label="Invite code">
          <Notice kind="warn">
            Mesh is in {beta?.label?.toLowerCase() ?? 'beta'} and this wallet is not on the list yet. Enter your invite code, then sign again.
          </Notice>
          <input
            id="invite-code"
            className="input mono"
            placeholder="ABCDE-FGHJK"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={auth.invite}
            onChange={(e) => auth.setInvite(e.target.value.toUpperCase())}
            aria-label="Invite code"
            disabled={busy}
          />
        </div>
      ) : null}
      <div className="row between">
        <span className="eyebrow">Chain</span>
        <div className="seg" role="tablist" aria-label="Chain">
          <button role="tab" aria-selected={auth.chain === 'solana'} className={auth.chain === 'solana' ? 'on' : ''} onClick={() => auth.setChain('solana')} disabled={busy}>
            Solana
          </button>
          <button role="tab" aria-selected={auth.chain === 'evm'} className={auth.chain === 'evm' ? 'on' : ''} onClick={() => auth.setChain('evm')} disabled={busy}>
            EVM
          </button>
        </div>
      </div>
      <div className="wallet-list">
        {auth.chain === 'solana'
          ? getSolanaAdapters().map((a) => {
              const ready = solanaReady(a);
              return (
                <button key={a.name} className="wallet-btn" disabled={busy || !ready} onClick={() => auth.signInSolana(a.name)}>
                  <span>{a.name}</span>
                  <span className="s">{ready ? 'Detected' : 'Not installed'}</span>
                </button>
              );
            })
          : EVM_WALLETS.map((w) => {
              const ready = evmInstalled(w.id);
              return (
                <button key={w.id} className="wallet-btn" disabled={busy || !ready} onClick={() => auth.signInEvm(w.id)}>
                  <span>{w.name}</span>
                  <span className="s">{ready ? 'Detected' : 'Not installed'}</span>
                </button>
              );
            })}
        {MOCK ? (
          <button className="wallet-btn" disabled={busy} onClick={() => auth.signInMock()}>
            <span>Mock wallet</span>
            <span className="s">VITE_MOCK</span>
          </button>
        ) : null}
      </div>
      {statusText ? (
        <div className="row small muted">
          <Spinner /> {statusText}
        </div>
      ) : null}
    </Modal>
  );
}
