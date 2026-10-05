import { useEffect, useState } from 'react';
import { useConnectors } from 'wagmi';
import { CHAIN_LABEL, DEFAULT_CHAIN, MOCK, TOKENOMICS } from '../config';
import { useAuth } from '../lib/auth';
import { useBeta } from '../lib/hooks';
import { ROBINHOOD_CHAIN } from '../lib/staking';
import { errorMessage, useToast } from '../lib/toast';
import { addRobinhoodChain, evmWalletOptions, getSolanaAdapters, solanaReady, type EvmWalletOption } from '../lib/wallets';
import { Modal, Notice, Spinner } from './ui';

const WALLET_LINKS = [
  { name: 'Phantom', href: 'https://phantom.com/download' },
  { name: 'MetaMask', href: 'https://metamask.io/download' },
] as const;

/**
 * Optional "Add Robinhood Chain to wallet". Sign-in never needs it (personal_sign works on any network);
 * it is here for holders who want the chain in the wallet and for staking later.
 */
function AddChainButton({ options, disabled }: { options: EvmWalletOption[]; disabled: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!options.length || DEFAULT_CHAIN !== 'evm') return null;
  const target = options[0]!;
  const run = async () => {
    setBusy(true);
    try {
      await addRobinhoodChain(target.connector);
      toast.ok(`${ROBINHOOD_CHAIN.name} is in ${target.name}`);
    } catch (err) {
      const msg = errorMessage(err);
      if (/reject|denied|cancel/i.test(msg)) toast.info('Cancelled');
      else toast.error(msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn ghost sm" onClick={run} disabled={disabled || busy} aria-busy={busy}>
      {busy ? <Spinner /> : null}
      Add {ROBINHOOD_CHAIN.name} to {options.length === 1 ? target.name : 'wallet'} <span className="muted">· optional</span>
    </button>
  );
}

export function ConnectModal() {
  const auth = useAuth();
  const beta = useBeta();
  const connectors = useConnectors();
  const [, bump] = useState(0);
  // Only a `solana` DEFAULT_CHAIN offers the chain toggle; on Robinhood Chain the modal is EVM-only.
  const showChainTabs = DEFAULT_CHAIN === 'solana';
  const chain = showChainTabs ? auth.chain : 'evm';

  // Solana adapters report readiness asynchronously; re-render once they settle.
  useEffect(() => {
    if (!auth.modalOpen || !showChainTabs) return;
    const adapters = getSolanaAdapters();
    const onChange = () => bump((n) => n + 1);
    adapters.forEach((a) => a.on('readyStateChange', onChange));
    const t = window.setTimeout(onChange, 400);
    return () => {
      adapters.forEach((a) => a.off('readyStateChange', onChange));
      window.clearTimeout(t);
    };
  }, [auth.modalOpen, showChainTabs]);

  // EIP-6963 wallets can announce a beat after mount; wagmi's connector store updates and so do we, but
  // `window.ethereum`-only wallets do not, so look once more shortly after opening.
  useEffect(() => {
    if (!auth.modalOpen) return;
    const t = window.setTimeout(() => bump((n) => n + 1), 500);
    return () => window.clearTimeout(t);
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
  const evmOptions = chain === 'evm' ? evmWalletOptions(connectors) : [];
  const solanaOptions = chain === 'solana' ? getSolanaAdapters().filter(solanaReady) : [];
  const none = chain === 'evm' ? evmOptions.length === 0 : solanaOptions.length === 0;

  return (
    <Modal title="Connect a wallet" onClose={auth.closeModal}>
      <p className="small muted">
        Sign a message to prove you own the wallet. No transaction, no gas. {TOKENOMICS.ticker} lives on <span className="mono">{CHAIN_LABEL}</span>
        {chain === 'evm' ? '; your wallet can stay on any network to sign in.' : '.'}
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
      {showChainTabs ? (
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
      ) : null}
      <div className="wallet-list" aria-label="Wallets">
        {chain === 'solana'
          ? solanaOptions.map((a) => (
              <button key={a.name} className="wallet-btn" disabled={busy} onClick={() => auth.signInSolana(a.name)}>
                <span className="wallet-name">
                  {a.icon ? <img className="wallet-icon" src={a.icon} alt="" width={24} height={24} /> : null}
                  {a.name}
                </span>
                <span className="s">Detected</span>
              </button>
            ))
          : evmOptions.map((w) => (
              <button key={w.id} className="wallet-btn" disabled={busy} onClick={() => auth.signInEvm(w.id)}>
                <span className="wallet-name">
                  {w.icon ? <img className="wallet-icon" src={w.icon} alt="" width={24} height={24} /> : <span className="wallet-icon ph" aria-hidden="true" />}
                  {w.name}
                </span>
                <span className="s">Detected</span>
              </button>
            ))}
        {none ? (
          <div className="wallet-none" role="status">
            <b>No wallet detected</b>
            <span className="small muted">
              Install a browser wallet extension, then reload this page. Phantom, MetaMask, Rabby, Coinbase Wallet, Rainbow and Brave all work
              {chain === 'evm' ? ' (any EVM wallet does)' : ''}.
            </span>
            <span className="small">
              Get{' '}
              {WALLET_LINKS.map((l, i) => (
                <span key={l.name}>
                  {i ? ' or ' : ''}
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.name}
                  </a>
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {MOCK ? (
          <button className="wallet-btn" disabled={busy} onClick={() => auth.signInMock()}>
            <span className="wallet-name">Mock wallet</span>
            <span className="s">VITE_MOCK</span>
          </button>
        ) : null}
      </div>
      {chain === 'evm' && evmOptions.length ? (
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <AddChainButton options={evmOptions} disabled={busy} />
        </div>
      ) : null}
      {statusText ? (
        <div className="row small muted">
          <Spinner /> {statusText}
        </div>
      ) : null}
    </Modal>
  );
}
