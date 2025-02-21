import type {
  ApiBackendStakingState,
  ApiNetwork,
  ApiStakingCommonData,
  ApiStakingState,
  ApiStakingType,
} from '../../types';
import type { CheckTransactionDraftResult, SubmitTransferResult } from './transactions';
import type { TonTransferParams } from './types';
import { ApiCommonError, ApiLiquidUnstakeMode, ApiTransactionDraftError } from '../../types';

import {
  LIQUID_JETTON, LIQUID_POOL, ONE_TON, TON_TOKEN_SLUG, VALIDATION_PERIOD_MS,
} from '../../../config';
import { parseAccountId } from '../../../util/account';
import { bigintDivideToNumber, bigintMultiplyToNumber } from '../../../util/bigint';
import { fromDecimal } from '../../../util/decimals';
import {
  buildLiquidStakingDepositBody,
  buildLiquidStakingWithdrawBody,
  getTokenBalance,
  getTonWeb,
  resolveTokenWalletAddress,
  toBase64Address,
} from './util/tonweb';
import { NominatorPool } from './contracts/NominatorPool';
import { fetchStoredAddress } from '../../common/accounts';
import { apiDb } from '../../db';
import { STAKE_COMMENT, UNSTAKE_COMMENT } from './constants';
import { checkTransactionDraft, submitTransfer } from './transactions';
import { isAddressInitialized } from './wallet';

export async function checkStakeDraft(
  accountId: string,
  amount: bigint,
  commonData: ApiStakingCommonData,
  backendState: ApiBackendStakingState,
) {
  const staked = await getStakingState(accountId, commonData, backendState);

  let type: ApiStakingType;
  let result: CheckTransactionDraftResult;

  if (staked?.type === 'nominators' && amount >= ONE_TON) {
    type = 'nominators';

    const poolAddress = backendState.nominatorsPool.address;
    amount += ONE_TON;
    result = await checkTransactionDraft(accountId, TON_TOKEN_SLUG, poolAddress, amount, STAKE_COMMENT);
  } else if (amount < ONE_TON) {
    return { error: ApiTransactionDraftError.InvalidAmount };
  } else {
    type = 'liquid';

    const body = buildLiquidStakingDepositBody();
    result = await checkTransactionDraft(accountId, TON_TOKEN_SLUG, LIQUID_POOL, amount, body);
  }

  return {
    ...result,
    type,
  };
}

export async function checkUnstakeDraft(
  accountId: string,
  amount: bigint,
  commonData: ApiStakingCommonData,
  backendState: ApiBackendStakingState,
) {
  const { network } = parseAccountId(accountId);
  const address = await fetchStoredAddress(accountId);
  const staked = await getStakingState(accountId, commonData, backendState);

  let type: ApiStakingType;
  let result: CheckTransactionDraftResult;
  let tokenAmount: bigint | undefined;

  if (staked.type === 'nominators') {
    type = 'nominators';

    const poolAddress = backendState.nominatorsPool.address;
    result = await checkTransactionDraft(
      accountId, TON_TOKEN_SLUG, poolAddress, ONE_TON, UNSTAKE_COMMENT,
    );
  } else if (staked.type === 'liquid') {
    type = 'liquid';

    if (amount > staked.amount) {
      return { error: ApiTransactionDraftError.InsufficientBalance };
    } else if (amount === staked.amount) {
      tokenAmount = staked.tokenAmount;
    } else {
      tokenAmount = bigintDivideToNumber(amount, commonData.liquid.currentRate);
    }

    const params = await buildLiquidStakingWithdraw(network, address, tokenAmount);
    result = await checkTransactionDraft(
      accountId, TON_TOKEN_SLUG, params.toAddress, params.amount, params.payload,
    );
  } else {
    return { error: ApiCommonError.Unexpected };
  }

  return {
    ...result,
    type,
    tokenAmount,
  };
}

export async function submitStake(
  accountId: string,
  password: string,
  amount: bigint,
  type: ApiStakingType,
  backendState: ApiBackendStakingState,
) {
  let result: SubmitTransferResult;

  if (type === 'liquid') {
    amount += ONE_TON;
    result = await submitTransfer(
      accountId,
      password,
      TON_TOKEN_SLUG,
      LIQUID_POOL,
      amount,
      buildLiquidStakingDepositBody(),
    );
  } else {
    const poolAddress = backendState.nominatorsPool.address;
    result = await submitTransfer(
      accountId,
      password,
      TON_TOKEN_SLUG,
      toBase64Address(poolAddress, true),
      amount,
      STAKE_COMMENT,
    );
  }

  return result;
}

export async function submitUnstake(
  accountId: string,
  password: string,
  type: ApiStakingType,
  amount: bigint,
  backendState: ApiBackendStakingState,
) {
  const { network } = parseAccountId(accountId);
  const address = await fetchStoredAddress(accountId);

  let result: SubmitTransferResult;

  if (type === 'liquid') {
    const mode = (backendState.stakedAt ?? 0) > Date.now() - VALIDATION_PERIOD_MS
      ? ApiLiquidUnstakeMode.BestRate
      : ApiLiquidUnstakeMode.Default;
    const params = await buildLiquidStakingWithdraw(network, address, amount, mode);

    result = await submitTransfer(
      accountId,
      password,
      TON_TOKEN_SLUG,
      params.toAddress,
      params.amount,
      params.payload,
    );
  } else {
    const poolAddress = backendState.nominatorsPool.address;
    result = await submitTransfer(
      accountId,
      password,
      TON_TOKEN_SLUG,
      toBase64Address(poolAddress, true),
      ONE_TON,
      UNSTAKE_COMMENT,
    );
  }

  return result;
}

export async function buildLiquidStakingWithdraw(
  network: ApiNetwork,
  address: string,
  amount: bigint,
  mode: ApiLiquidUnstakeMode = ApiLiquidUnstakeMode.Default,
): Promise<TonTransferParams> {
  const tokenWalletAddress = await resolveTokenWalletAddress(network, address, LIQUID_JETTON);

  const payload = buildLiquidStakingWithdrawBody({
    amount,
    responseAddress: address,
    fillOrKill: mode === ApiLiquidUnstakeMode.Instant,
    waitTillRoundEnd: mode === ApiLiquidUnstakeMode.BestRate,
  });

  return {
    amount: ONE_TON,
    toAddress: tokenWalletAddress,
    payload,
  };
}

export async function getStakingState(
  accountId: string,
  commonData: ApiStakingCommonData,
  backendState: ApiBackendStakingState,
): Promise<ApiStakingState> {
  const { network } = parseAccountId(accountId);
  const address = toBase64Address(await fetchStoredAddress(accountId), true);

  const { currentRate, collection } = commonData.liquid;
  const tokenBalance = await getLiquidStakingTokenBalance(accountId);
  let unstakeAmount = 0n;

  if (collection) {
    const nfts = await apiDb.nfts.where({
      accountId,
      collectionAddress: collection,
    }).toArray();

    for (const nft of nfts) {
      const billAmount = nft.name?.match(/Bill for (?<amount>[\d.]+) Pool Jetton/)?.groups?.amount;
      if (billAmount) {
        unstakeAmount += fromDecimal(billAmount);
      }
    }
  }

  const { loyaltyType, shouldUseNominators } = backendState;

  const isInstantUnstake = !commonData.liquid.collection
    && Date.now() - (backendState.stakedAt ?? 0) > VALIDATION_PERIOD_MS;
  const liquidAvailable = isInstantUnstake ? commonData.liquid.available : 0n;

  let liquidApy = commonData.liquid.apy;
  if (loyaltyType && loyaltyType in commonData.liquid.loyaltyApy) {
    liquidApy = commonData.liquid.loyaltyApy[loyaltyType];
  }

  if (tokenBalance > 0n || unstakeAmount > 0n) {
    const fullTokenAmount = tokenBalance + unstakeAmount;
    const amount = bigintMultiplyToNumber(fullTokenAmount, currentRate);

    return {
      type: 'liquid',
      tokenAmount: tokenBalance,
      amount,
      unstakeRequestAmount: unstakeAmount,
      apy: liquidApy,
      instantAvailable: liquidAvailable,
    };
  }

  const poolAddress = backendState.nominatorsPool.address;
  const nominatorPool = getPoolContract(network, poolAddress);
  const nominators = await nominatorPool.getListNominators();
  const currentNominator = nominators.find((n) => n.address === address);

  if (currentNominator) {
    return {
      type: 'nominators',
      amount: fromDecimal(currentNominator.amount),
      pendingDepositAmount: fromDecimal(currentNominator.pendingDepositAmount),
      isUnstakeRequested: currentNominator.withdrawRequested,
    };
  } else if (shouldUseNominators) {
    return {
      type: 'nominators',
      amount: 0n,
      pendingDepositAmount: 0n,
      isUnstakeRequested: false,
    };
  } else {
    return {
      type: 'liquid',
      tokenAmount: 0n,
      amount: 0n,
      unstakeRequestAmount: 0n,
      apy: liquidApy,
      instantAvailable: liquidAvailable,
    };
  }
}

function getPoolContract(network: ApiNetwork, poolAddress: string) {
  return new NominatorPool(getTonWeb(network).provider, { address: poolAddress });
}

async function getLiquidStakingTokenBalance(accountId: string) {
  const { network } = parseAccountId(accountId);
  if (network !== 'mainnet') {
    return 0n;
  }

  const address = await fetchStoredAddress(accountId);
  const walletAddress = await resolveTokenWalletAddress(network, address, LIQUID_JETTON);
  const isInitialized = await isAddressInitialized(network, walletAddress);

  if (!isInitialized) {
    return 0n;
  }

  return getTokenBalance(network, walletAddress);
}
