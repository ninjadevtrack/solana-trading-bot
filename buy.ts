import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V2,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import {
  getAllAccountsV4,
  getTokenAccounts,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
  OPENBOOK_PROGRAM_ID,
  createPoolKeys,
} from './liquidity';
import { retrieveEnvVariable } from './utils';
import { getAllMarketsV3, MinimalMarketLayoutV3 } from './market';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import BN from 'bn.js';

const transport = pino.transport({
  targets: [

    {
      level: 'trace',
      target: 'pino/file',
      options: {
        destination: 'buy.log',
      },
    },

    {
      level: 'trace',
      target: 'pino-pretty',
      options: {},
    },
  ],
});

export const logger = pino(
  {
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
  'RPC_WEBSOCKET_ENDPOINT',
  logger,
);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<
  string,
  MinimalTokenAccountData
>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable(
  'COMMITMENT_LEVEL',
  logger,
) as Commitment;

const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(
  retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger),
);
let snipeList: string[] = [];

async function init(): Promise<void> {
  // get wallet
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(
        `Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`,
      );
    }
  }

  logger.info(
    `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`,
  );


  let message = {
    embeds: [
      {
        title: `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`,
        color: 1127128,
      },
    ],
  };

  // post it to discord
  const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
  // use native fetch to post to discord
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  // get all existing liquidity pools
  const allLiquidityPools = await getAllAccountsV4(
    solanaConnection,
    quoteToken.mint,
    commitment,
  );
  existingLiquidityPools = new Set(
    allLiquidityPools.map((p) => p.id.toString()),
  );

  // get all open-book markets
  const allMarkets = await getAllMarketsV3(
    solanaConnection,
    quoteToken.mint,
    commitment,
  );
  existingOpenBookMarkets = new Set(allMarkets.map((p) => p.id.toString()));

  logger.info(
    `Total ${quoteToken.symbol} markets ${existingOpenBookMarkets.size}`,
  );
  logger.info(
    `Total ${quoteToken.symbol} pools ${existingLiquidityPools.size}`,
  );

  // post to discord webhook
  message = {
    embeds: [
      {
        title: `Total ${quoteToken.symbol} markets ${existingOpenBookMarkets.size}`,
        color: 1127128,
      },
      {
        title: `Total ${quoteToken.symbol} pools ${existingLiquidityPools.size}`,
        color: 14177041,
      },
    ],
  };

  // post it to discord
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(
    solanaConnection,
    wallet.publicKey,
    commitment,
  );

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <
      MinimalTokenAccountData
      >{
        mint: ta.accountInfo.mint,
        address: ta.pubkey,
      });
  }

  const tokenAccount = tokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString(),
  )!;

  if (!tokenAccount) {
    throw new Error(
      `No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`,
    );
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
}

export async function processRaydiumPool(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: LiquidityStateV4 | undefined;
  try {
    accountData = LIQUIDITY_STATE_LAYOUT_V4.decode(
      updatedAccountInfo.accountInfo.data,
    );

    if (!shouldBuy(accountData.baseMint.toString())) {
      return;
    }

    await buy(updatedAccountInfo.accountId, accountData);

    // Auto sell if enabled in .env file
    const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger);
    if (AUTO_SELL === 'true') {
      const SELL_DELAY = Number(retrieveEnvVariable('SELL_DELAY', logger));
      await new Promise((resolve) => setTimeout(resolve, SELL_DELAY));
      await sell(updatedAccountInfo.accountId, accountData);
    } else {
      logger.info(
        `Auto sell is disabled. To enable it, set AUTO_SELL=true in .env file`,
      );
    }
  } catch (e) {
    logger.error({ ...accountData, error: e }, `Failed to process pool`);
  }
}

export async function processOpenBookMarket(
  updatedAccountInfo: KeyedAccountInfo,
) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(
      updatedAccountInfo.accountInfo.data,
    );

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    const ata = getAssociatedTokenAddressSync(
      accountData.baseMint,
      wallet.publicKey,
    );
    existingTokenAccounts.set(accountData.baseMint.toString(), <
      MinimalTokenAccountData
      >{
        address: ata,
        mint: accountData.baseMint,
        market: <MinimalMarketLayoutV3>{
          bids: accountData.bids,
          asks: accountData.asks,
          eventQueue: accountData.eventQueue,
        },
      });
  } catch (e) {
    logger.error({ ...accountData, error: e }, `Failed to process market`);
  }
}

async function buy(
  accountId: PublicKey,
  accountData: LiquidityStateV4,
): Promise<void> {
  const tokenAccount = existingTokenAccounts.get(
    accountData.baseMint.toString(),
  );

  if (!tokenAccount) {
    return;
  }

  tokenAccount.poolKeys = createPoolKeys(
    accountId,
    accountData,
    tokenAccount.market!,
  );
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: tokenAccount.poolKeys,
      userKeys: {
        tokenAccountIn: quoteTokenAssociatedAddress,
        tokenAccountOut: tokenAccount.address,
        owner: wallet.publicKey,
      },
      amountIn: quoteAmount.raw,
      minAmountOut: 0,
    },
    tokenAccount.poolKeys.version,
  );

  const latestBlockhash = await solanaConnection.getLatestBlockhash({
    commitment: commitment,
  });
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        tokenAccount.address,
        wallet.publicKey,
        accountData.baseMint,
      ),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet, ...innerTransaction.signers]);
  const signature = await solanaConnection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    },
  );
  logger.info(
    {
      mint: accountData.baseMint,
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    },
    'Buy',
  );

  // post to discord webhook
  const message = {
    embeds: [
      {
        title: `Bought token: ${accountData.baseMint.toBase58()}`,
        color: 1127128,
        url: `https://solscan.io/tx/${signature}?cluster=${network}`,
      },
    ],
  };

  const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
  // use native fetch to post to discord
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
}

const maxRetries = 60;
async function sell(
  accountId: PublicKey,
  accountData: LiquidityStateV4,
): Promise<void> {
  const tokenAccount = existingTokenAccounts.get(
    accountData.baseMint.toString(),
  );

  if (!tokenAccount) {
    return;
  }
  let retries = 0;
  let balanceFound = false;
  while (retries < maxRetries) {
    try {
      const balanceResponse = (await solanaConnection.getTokenAccountBalance(tokenAccount.address)).value.amount;
      if (balanceResponse !== null && Number(balanceResponse) > 0 && !balanceFound) {
        balanceFound = true;
        console.log("Token balance: ", balanceResponse);
        // send to discord
        const tokenBalanceMessage = {
          embeds: [
            {
              title: `Token balance: ${balanceResponse}`,
              color: 1127128,
            },
          ],
        };

        const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
        // use native fetch to post to discord
        fetch(DISCORD_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(tokenBalanceMessage),
        });

        tokenAccount.poolKeys = createPoolKeys(
          accountId,
          accountData,
          tokenAccount.market!,
        );
        const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys: tokenAccount.poolKeys,
            userKeys: {
              tokenAccountIn: tokenAccount.address,
              tokenAccountOut: quoteTokenAssociatedAddress,
              owner: wallet.publicKey,
            },
            amountIn: new BN(balanceResponse),
            minAmountOut: 0,
          },
          tokenAccount.poolKeys.version,
        );

        const latestBlockhash = await solanaConnection.getLatestBlockhash({
          commitment: commitment,
        });
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
            createAssociatedTokenAccountIdempotentInstruction(
              wallet.publicKey,
              tokenAccount.address,
              wallet.publicKey,
              accountData.baseMint,
            ),
            ...innerTransaction.instructions,
          ],
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet, ...innerTransaction.signers]);
        const signature = await solanaConnection.sendRawTransaction(
          transaction.serialize(),
          {
            maxRetries: 5,
            preflightCommitment: commitment,
          },
        );
        logger.info(
          {
            mint: accountData.baseMint,
            url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          },
          'sell',
        );

        // post to discord webhook
        const sellMessage = {
          embeds: [
            {
              title: `Sold token: ${accountData.baseMint.toBase58()}`,
              color: 1127128,
              url: `https://solscan.io/tx/${signature}?cluster=${network}`,
            },
          ],
        };

        // const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
        // use native fetch to post to discord
        fetch(DISCORD_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(sellMessage),
        });

        break;
      }
    } catch (error) {
    }
    retries++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}


function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await init();
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingLiquidityPools.has(key);
      if (!existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V2.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V2.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);

  // post to discord webhook
  const message = {
    embeds: [
      {
        title: `Listening for raydium changes: ${raydiumSubscriptionId}`,
        color: 1127128,
      },
      {
        title: `Listening for open book changes: ${openBookSubscriptionId}`,
        color: 14177041,
      },
    ],
  };

  const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
  // use native fetch to post to discord
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();