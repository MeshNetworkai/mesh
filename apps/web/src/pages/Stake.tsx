import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { Notice, Skeleton, Spinner, Tile } from '../components/ui';
import { MOCK, TOKENOMICS } from '../config';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtInt } from '../lib/format';
import { useMyStake, useStakeTiers } from '../lib/hooks';
import { STAKING_TARGET, erc20Abi, fromWei, meshStakingAbi, toWei } from '../lib/staking';
import { errorMessage, useToast } from '../lib/toast';
import type { MyStake, StakeTierView } from '../lib/types';

const TICKER = TOKENOMICS.ticker;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtMult = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(m * 10 === Math.round(m * 10) ? 1 : 2)}×`;
const fmtLock = (days: number) => (days ? `${days} days` : 'none');

/** Tiers table with the wallet's current tier marked. */
function TiersTable({ tiers, current, loading }: { tiers: StakeTierView[] | null; current: number | null; loading: boolean }) {
  if (loading && !tiers) {
    return (
      <div className="tblwrap">
        <table className="tbl">
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <td>
                  <Skeleton w="7ch" />
                </td>
                <td className="num">
                  <Skeleton w="9ch" />
                </td>
                <td className="num">
                  <Skeleton w="6ch" />
                </td>
                <td className="num">
                  <Skeleton w="4ch" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="tblwrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Tier</th>
            <th className="num">Min stake</th>
            <th className="num">Lock</th>
            <th className="num">Node rewards</th>
            <th>Queue</th>
          </tr>
        </thead>
        <tbody>
          {(tiers ?? []).map((t, i) => {
            const on = current === i;
            return (
              <tr key={t.name} aria-current={on ? 'true' : undefined} style={on ? { background: 'var(--accent-soft)' } : undefined}>
                <td>
                  <span className="row" style={{ gap: 8 }}>
                    {cap(t.name)}
                    {on ? (
                      <span className="pill sm">
                        <span className="dot dot-live" aria-hidden="true" />
                        you
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="num">
                  {t.minStake === 0 ? '—' : `${fmtInt(t.minStake)} ${TICKER}`}
                </td>
                <td className="num">{fmtLock(t.lockDays)}</td>
                <td className="num">{fmtMult(t.multiplier)}</td>
                <td className="small muted">{i === 0 ? 'standard' : i === (tiers?.length ?? 0) - 1 ? 'front of the queue' : 'ahead of unstaked nodes'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Stake / unstake against MeshStaking via wagmi. Only rendered when the deploy json carries the contract. */
function StakeForm({ tiers, mine, onChanged }: { tiers: StakeTierView[]; mine: MyStake | null; onChanged: () => void }) {
  const target = STAKING_TARGET!;
  const toast = useToast();
  const { address, chainId, isConnected } = useAccount();
  const [amount, setAmount] = useState('');
  const [lockDays, setLockDays] = useState<number>(0);
  const [unstakeAmount, setUnstakeAmount] = useState('');
  const [step, setStep] = useState<'idle' | 'approve' | 'stake' | 'unstake'>('idle');

  const position = useReadContract({
    address: target.staking,
    abi: meshStakingAbi,
    functionName: 'positionOf',
    args: address ? [address] : undefined,
    chainId: target.chain.id,
    query: { enabled: Boolean(address) },
  });
  const allowance = useReadContract({
    address: target.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, target.staking] : undefined,
    chainId: target.chain.id,
    query: { enabled: Boolean(address) },
  });
  const balance = useReadContract({
    address: target.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: target.chain.id,
    query: { enabled: Boolean(address) },
  });

  const { writeContractAsync, data: txHash, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId: target.chain.id });

  useEffect(() => {
    if (!receipt.isSuccess || !txHash) return;
    void position.refetch();
    void allowance.refetch();
    void balance.refetch();
    if (step === 'approve') {
      toast.ok('Approved. Confirm the stake in your wallet.');
      setStep('idle');
      reset();
      return;
    }
    toast.ok(step === 'unstake' ? 'Unstaked.' : 'Staked. Your tier updates at the next epoch.');
    setStep('idle');
    setAmount('');
    setUnstakeAmount('');
    reset();
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, txHash]);

  useEffect(() => {
    if (receipt.isError) {
      toast.error('Transaction failed on chain.');
      setStep('idle');
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isError]);

  const pos = position.data;
  const stakedWei = pos?.amount ?? 0n;
  const lockEnd = pos ? Number(pos.lockEndsAt) : mine?.lockEndsAt ?? 0;
  const committedLock = pos ? Number(pos.lockDays) : mine?.lockDays ?? 0;
  const locked = lockEnd > Date.now() / 1000;
  const lockOptions = useMemo(() => [...new Set(tiers.map((t) => t.lockDays))].sort((a, b) => a - b), [tiers]);
  const wrongChain = isConnected && chainId !== target.chain.id;
  const busy = step !== 'idle' || receipt.isLoading;

  const run = async (fn: () => Promise<`0x${string}`>) => {
    try {
      await fn();
    } catch (err) {
      const msg = errorMessage(err);
      toast.error(/reject|denied|cancel/i.test(msg) ? 'Signature cancelled.' : msg.split('\n')[0]);
      setStep('idle');
    }
  };

  const onStake = async (e: FormEvent) => {
    e.preventDefault();
    if (!address) return;
    let wei: bigint;
    try {
      wei = toWei(amount, target.decimals);
    } catch (err) {
      return toast.error(errorMessage(err));
    }
    if (wei <= 0n) return toast.error('Enter an amount');
    if (balance.data !== undefined && wei > balance.data) return toast.error(`You hold ${fmtInt(Math.floor(fromWei(balance.data, target.decimals)))} ${TICKER}`);
    const lock = Math.max(lockDays, committedLock);
    if ((allowance.data ?? 0n) < wei) {
      setStep('approve');
      await run(() => writeContractAsync({ address: target.token, abi: erc20Abi, functionName: 'approve', args: [target.staking, wei], chainId: target.chain.id }));
      return;
    }
    setStep('stake');
    await run(() => writeContractAsync({ address: target.staking, abi: meshStakingAbi, functionName: 'stake', args: [wei, lock], chainId: target.chain.id }));
  };

  const onUnstake = async (e: FormEvent) => {
    e.preventDefault();
    if (!address) return;
    let wei: bigint;
    try {
      wei = unstakeAmount.trim() === '' ? stakedWei : toWei(unstakeAmount, target.decimals);
    } catch (err) {
      return toast.error(errorMessage(err));
    }
    if (wei <= 0n) return toast.error('Nothing to unstake');
    if (wei > stakedWei) return toast.error('More than you have staked');
    setStep('unstake');
    await run(() => writeContractAsync({ address: target.staking, abi: meshStakingAbi, functionName: 'unstake', args: [wei], chainId: target.chain.id }));
  };

  const needsApproval = (() => {
    try {
      return (allowance.data ?? 0n) < toWei(amount || '0', target.decimals);
    } catch {
      return false;
    }
  })();

  return (
    <div className="panels">
      <form className="panel" onSubmit={onStake}>
        <span className="eyebrow">Stake</span>
        <span className="hint">
          Contract <code className="mono">{target.staking.slice(0, 6)}…{target.staking.slice(-4)}</code> on {target.chain.name}. Approve once, then stake. Adding to a
          position never shortens an existing lock.
        </span>
        {!isConnected ? <Notice kind="warn">Connect an EVM wallet (MetaMask or Rabby) to stake.</Notice> : null}
        {wrongChain ? <Notice kind="warn">Switch your wallet to {target.chain.name} to stake.</Notice> : null}
        <div className="field">
          <label htmlFor="stake-amount">Amount · {TICKER}</label>
          <input id="stake-amount" className="input num" inputMode="decimal" placeholder="10000" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          {balance.data !== undefined ? <span className="small muted">Balance {fmtInt(Math.floor(fromWei(balance.data, target.decimals)))} {TICKER}</span> : null}
        </div>
        <div className="field">
          <label htmlFor="stake-lock">Lock</label>
          <select id="stake-lock" className="input" value={lockDays} onChange={(e) => setLockDays(Number(e.target.value))} disabled={busy}>
            {lockOptions.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? 'No lock' : `${d} days`}
                {tiers.filter((t) => t.lockDays === d && t.minStake > 0).length ? ` · unlocks ${tiers.filter((t) => t.lockDays === d && t.minStake > 0).map((t) => cap(t.name)).join(', ')}` : ''}
              </option>
            ))}
          </select>
          {committedLock > lockDays ? <span className="small muted">You already committed to {committedLock} days; that commitment stays.</span> : null}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" type="submit" disabled={busy || !isConnected || wrongChain} aria-busy={busy}>
            {busy && step !== 'unstake' ? <Spinner /> : null}
            {step === 'approve' ? 'Approving…' : step === 'stake' ? 'Staking…' : needsApproval ? `Approve ${TICKER}` : 'Stake'}
          </button>
        </div>
      </form>

      <form className="panel" onSubmit={onUnstake}>
        <span className="eyebrow">Unstake</span>
        <span className="hint">
          {stakedWei > 0n ? `${fmtInt(Math.floor(fromWei(stakedWei, target.decimals)))} ${TICKER} staked.` : 'Nothing staked from this wallet yet.'}{' '}
          {locked ? `Locked until ${fmtDate(lockEnd)}.` : 'No active lock: withdraw any time.'}
        </span>
        <div className="field">
          <label htmlFor="unstake-amount">Amount · {TICKER} · blank for all</label>
          <input id="unstake-amount" className="input num" inputMode="decimal" placeholder="all" value={unstakeAmount} onChange={(e) => setUnstakeAmount(e.target.value)} disabled={busy || locked} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" type="submit" disabled={busy || !isConnected || wrongChain || locked || stakedWei === 0n} aria-busy={step === 'unstake'} title={locked ? `Locked until ${fmtDate(lockEnd)}` : undefined}>
            {step === 'unstake' ? <Spinner /> : null}
            {step === 'unstake' ? 'Unstaking…' : locked ? `Locked until ${fmtDate(lockEnd)}` : 'Unstake'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Mock mode: the same two panels, acting on a demo position. */
function MockStakeForm() {
  const toast = useToast();
  return (
    <div className="panels">
      <div className="panel">
        <span className="eyebrow">Stake</span>
        <span className="hint">Mock mode shows a staked example. On a live gateway this panel approves and stakes through your wallet.</span>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={() => toast.info('Mock mode: no transaction sent.')}>
            Stake
          </button>
        </div>
      </div>
      <div className="panel">
        <span className="eyebrow">Unstake</span>
        <span className="hint">The example position is locked for 18 more days.</span>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" disabled title="Locked">
            Locked
          </button>
        </div>
      </div>
    </div>
  );
}

export function Stake() {
  const { session } = useAuth();
  const tiers = useStakeTiers();
  const mine = useMyStake();
  const list = tiers.data?.tiers ?? null;
  const loading = (tiers.loading && !tiers.data) || (mine.loading && !mine.data);
  const current = mine.data?.tierIndex ?? null;
  const live = MOCK || STAKING_TARGET !== null;
  const sessionIsEvm = session?.chain === 'evm';

  return (
    <>
      <div className="row between">
        <span className="display d-s">Stake</span>
        <span className="small muted">{tiers.data ? `${tiers.data.chain} · tiers from tokenomics` : ''}</span>
      </div>
      <p className="muted" style={{ maxWidth: 640 }}>
        Lock {TICKER} to multiply what your nodes earn and move them to the front of the queue; the top tier plus the signed operator pledge makes a node trusted for
        other people's default-tier requests. Tiers are read from the staking contract once per epoch; the contract holds your tokens and nothing else — rewards are paid
        by the gateway. Staking does not change the holder pool.
      </p>

      {!live ? (
        <Notice kind="ok">
          Staking opens with the token launch. The contract is written and tested; your tier appears here the moment {TICKER} is live on Robinhood Chain. Until
          then every node earns the standard rate.
        </Notice>
      ) : null}

      {mine.error && !mine.data ? <Notice kind="bad">Could not load your position: {mine.error}</Notice> : null}
      {tiers.error && !tiers.data ? <Notice kind="bad">Could not load tiers: {tiers.error}</Notice> : null}

      {live ? (
        <div className="tiles">
          <Tile label="Your tier" loading={loading} value={mine.data ? cap(mine.data.tier.name) : '—'} delta={mine.data?.nextTier ? `${fmtInt(mine.data.nextTier.needStake)} ${TICKER} more${mine.data.nextTier.lockDays > mine.data.lockDays ? ` + ${mine.data.nextTier.lockDays}d lock` : ''} → ${cap(mine.data.nextTier.name)}` : mine.data ? 'Top tier' : '—'} deltaKind={mine.data?.nextTier ? '' : 'up'} />
          <Tile label="Staked" loading={loading} value={mine.data ? `${fmtInt(mine.data.staked)} ${TICKER}` : '—'} delta={mine.data?.lockDays ? `${mine.data.lockDays}-day lock committed` : 'No lock'} />
          <Tile label="Node rewards" loading={loading} value={mine.data ? fmtMult(mine.data.multiplier) : '—'} delta={mine.data && mine.data.multiplier > 1 ? 'applied to every job your nodes serve' : 'standard rate'} deltaKind={mine.data && mine.data.multiplier > 1 ? 'up' : ''} />
          <Tile label="Lock ends" loading={loading} value={mine.data?.lockEndsAt ? fmtDate(mine.data.lockEndsAt) : '—'} delta={mine.data?.lockEndsAt && mine.data.lockEndsAt > Date.now() / 1000 ? 'unstake after this' : 'nothing locked'} />
        </div>
      ) : null}

      <div className="stack sm">
        <div className="row between">
          <span className="eyebrow">Tiers</span>
          <span className="small muted">Highest tier whose minimum and lock you meet</span>
        </div>
        <TiersTable tiers={list} current={current} loading={tiers.loading} />
      </div>

      {!live ? null : MOCK ? (
        <MockStakeForm />
      ) : !sessionIsEvm ? (
        <Notice kind="warn">Staking lives on {STAKING_TARGET!.chain.name}. Sign in with an EVM wallet to stake from this page.</Notice>
      ) : list ? (
        <StakeForm tiers={list} mine={mine.data} onChanged={() => void mine.reload()} />
      ) : null}
    </>
  );
}
