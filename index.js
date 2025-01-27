import fetch from "cross-fetch";
import bs58 from "bs58";
import dotenv from "dotenv";
import chalk from "chalk";
import {
    LAMPORTS_PER_SOL,
    PublicKey,
    Transaction,
    SystemProgram,
    Keypair,
} from "@solana/web3.js";
import {
    JITO_FEES,
    tokenwithDecimals,
    SWAP_AMOUNT,
    CG_API_KEY,
    wrappedSolTokenAddress,
    connection,
    minLiquidityUsd,
    minVolumeUsd,
    minTransactions,
    jito_engine,
    wallet,
    COINGECKO_API_URL,
    DEX_SCREENER_URL,
    jito_tipaccounts,
} from "./config.js";
import axios from "axios";
import fs from 'fs';
import { buyToken, sellToken } from "./service.js";
import base58 from "bs58";
import { Wallet } from "@project-serum/anchor";
dotenv.config();

const headers = {
    accept: "application/json",
    "x-cg-pro-api-key": CG_API_KEY,
};

const checkWalletBalance = async() => {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;

        if (solBalance < SWAP_AMOUNT) {
            console.log(
                chalk.red(
                    `❌ Insufficient balance: You have ${solBalance} SOL, but ${SWAP_AMOUNT} SOL is required.`
                )
            );
            process.exit(1); // Exit the program if balance is insufficient
        }

        console.log(
            chalk.green(`✅ Sufficient balance: You have ${solBalance} SOL.`)
        );
        return true;
    } catch (error) {
        console.error(chalk.red("❌ Error checking wallet balance:"), error);
        process.exit(1); // Exit the program if there is an error checking balance
    }
};





const fetchPools = async(tokenAddress) => {
    const url = `${COINGECKO_API_URL}/${tokenAddress}/pools`;

    let retries = 5;

    while (retries > 0) {
        try {
            const response = await fetch(url, { headers });
            if (response.status === 200) {
                const data = await response.json();
                return filterPools(data.data || []);
            }

            if (response.status === 429) {
                const retryAfter =
                    parseInt(response.headers.get("Retry-After"), 10) || 10;
                console.log(
                    chalk.yellow(
                        `⚠️ Rate limit exceeded. Retrying after ${retryAfter} seconds...`
                    )
                );
                await delay(retryAfter * 1000);
            } else {
                return [];
            }
        } catch (error) {
            console.error(chalk.red("❌ Error: Failed to fetch data"), error);
            retries -= 1;
            if (retries === 0) return [];
        }
    }
};

const filterPools = (pools) => {
    return pools.filter((pool) => {
        try {
            const baseTokenId = pool.relationships.base_token.data.id;
            const quoteTokenId = pool.relationships.quote_token.data.id;
            const reserveInUsd = parseFloat(pool.attributes.reserve_in_usd);
            const volumeUsd24h = parseFloat(pool.attributes.volume_usd.h24);
            const transactions24h =
                pool.attributes.transactions.h24.buys +
                pool.attributes.transactions.h24.sells;

            return (
                (baseTokenId === `solana_${wrappedSolTokenAddress}` ||
                    quoteTokenId === `solana_${wrappedSolTokenAddress}`) &&
                reserveInUsd >= minLiquidityUsd &&
                volumeUsd24h >= minVolumeUsd &&
                transactions24h >= minTransactions
            );
        } catch (error) {
            console.error(
                chalk.red(`❌ Error while filtering pool ${pool.id}:`),
                error
            );
            return false;
        }
    });
};

const findHighestAndLowestPools = (pools) => {
    let highestPool = null;
    let lowestPool = null;

    pools.forEach((pool) => {
        const price = parseFloat(pool.attributes.base_token_price_native_currency);

        if (!highestPool ||
            price >
            parseFloat(highestPool.attributes.base_token_price_native_currency)
        ) {
            highestPool = pool;
        }

        if (!lowestPool || comparePoolPrices(lowestPool, pool)) {
            lowestPool = pool;
        }
    });

    return { highestPool, lowestPool };
};

const comparePoolPrices = (lowestPool, currentPool) => {
    const currentLowestBaseId = lowestPool.relationships.base_token.data.id;
    const currentPoolBaseId = currentPool.relationships.base_token.data.id;

    if (currentLowestBaseId !== currentPoolBaseId) {
        const currentLowestQuotePrice = parseFloat(
            lowestPool.attributes.quote_token_price_native_currency
        );
        const currentPoolQuotePrice = parseFloat(
            currentPool.attributes.quote_token_price_native_currency
        );
        return currentPoolQuotePrice < currentLowestQuotePrice;
    } else {
        const lowestPrice = parseFloat(
            lowestPool.attributes.base_token_price_native_currency
        );
        return (
            parseFloat(currentPool.attributes.base_token_price_native_currency) <
            lowestPrice
        );
    }
};

const calculateProfit = async(highestPool, lowestPool) => {
    try {
        const highestPriceSol = parseFloat(
            highestPool.attributes.base_token_price_native_currency
        );
        const baseTokenId = highestPool.relationships.base_token.data.id;
        const quoteTokenId = lowestPool.relationships.base_token.data.id;

        const lowestPriceSol =
            baseTokenId !== quoteTokenId ?
            parseFloat(lowestPool.attributes.quote_token_price_native_currency) :
            parseFloat(lowestPool.attributes.base_token_price_native_currency);

        if ([highestPriceSol, lowestPriceSol].some(isNaN)) {
            throw new Error("Invalid price data");
        }
        const pureProfit = highestPriceSol * SWAP_AMOUNT / lowestPriceSol - SWAP_AMOUNT - JITO_FEES;
        const solNeededForProfit = pureProfit;
        return solNeededForProfit;
    } catch (error) {
        console.error(chalk.red(`❌ Error while calculating profit:`), error);
        return Infinity;
    }
};

const generateDexScreenerUrl = (poolAddress) => {
    const pool = poolAddress.split("solana_")[1];
    return `${DEX_SCREENER_URL}${pool}`;
};

const fetchAndFilterAllPools = async() => {
    // await checkWalletBalance();

    const allFilteredPools = [];
    const opportunities = [];

    for (const token of tokenwithDecimals) {
        console.log(chalk.blue(`🔍 Fetching pools for token: ${token.address}`));

        const filteredPools = await fetchPools(token.address);
        console.log('bug point 1');

        if (filteredPools.length > 0) {
            allFilteredPools.push(...filteredPools);
            const { highestPool, lowestPool } =
            findHighestAndLowestPools(filteredPools);
            if (highestPool && lowestPool && highestPool.id !== lowestPool.id) {
                const solNeededForProfit = await calculateProfit(
                    highestPool,
                    lowestPool
                );
                console.log(`solneed`, solNeededForProfit);

                if (solNeededForProfit > SWAP_AMOUNT * 0.05) {
                    opportunities.push({
                        token: token.address,
                        highestPool: highestPool.id,
                        lowestPool: lowestPool.id,
                        solNeededForProfit,
                    });
                    console.log('bug point 2');
                    console.log(chalk.green(`💡 Opportunity found for token ${token.address}:`));
                    console.log(
                        chalk.green(`
            Highest Price Pool:
            Pool Address: ${generateDexScreenerUrl(highestPool.id)}
            Price: $${highestPool.attributes.token_price_usd}
            
            Lowest Price Pool:
            Pool Address: ${generateDexScreenerUrl(lowestPool.id)}
            Price: $${lowestPool.attributes.token_price_usd}
            
            Profit Margin: $${(
                                parseFloat(highestPool.attributes.token_price_usd) -
                                parseFloat(lowestPool.attributes.token_price_usd)
                            ).toFixed(7)} USD
            Profit amount based on your invest amount ${SWAP_AMOUNT} SOL: ${solNeededForProfit.toFixed(
                                7
                            )} SOL
            
            Check the pools on DEXScreener:
            View Highest Pool on DEXScreener: ${generateDexScreenerUrl(
                                highestPool.id
                            )}
            View Lowest Pool on DEXScreener: ${generateDexScreenerUrl(
                                lowestPool.id
                            )}
          `)
                    );

                    function getTokenData(pool) {
                        console.log(pool.relationships);
                        try {
                            const data = {
                                address: pool.attributes.address,
                                dex: pool.relationships.dex.data.id,
                                base: {
                                    mint: pool.relationships.base_token.data.id,
                                    decimal: tokenwithDecimals.find((token) => { return token.address === pool.relationships.base_token.data.id.split('_')[1] }).decimals,
                                },
                                quote: {
                                    mint: pool.relationships.quote_token.data.id,
                                    decimal: tokenwithDecimals.find((token) => { return token.address === pool.relationships.quote_token.data.id.split('_')[1] }).decimals,
                                }
                            };
                        } catch {
                            return;
                        }
                        return data
                    }

                    const highestPoolData = getTokenData(highestPool);
                    const lowestPoolData = getTokenData(lowestPool);
                    // const jitoTx = await createTipTransaction(wallet, connection);
                    // const tipTx = convertBase64ToBase58(jitoTx.serialize().toString('base64'));
                    try {
                        var buyTx;
                        var sellTx;

                        buyTx = await buyToken(lowestPoolData, SWAP_AMOUNT, highestPoolData);
                        console.log("TRADED", buyTx);

                        // setTimeout(async() => {
                        //     console.log("SELLING");

                        //     sellTx = await sellToken(highestPoolData, buyTx.amountOut);
                        // }, 2000)

                        // if (lowestPoolData.base.mint.split('_')[1] === wrappedSolTokenAddress) {
                        //     buyTx = await buyToken(lowestPoolData, SWAP_AMOUNT);
                        //     console.log("BUYTX LOW ===>", buyTx);
                        //     if (!buyTx) console.log("Buy_Base_Sol_error");
                        // } else {
                        //     buyTx = await sellToken(lowestPoolData, SWAP_AMOUNT);
                        //     console.log("BUYTX HIGH ===>", buyTx);
                        //     if (!buyTx) console.log("Buy_Base_Token_error");
                        // }

                        // if (lowestPoolData.base.mint.split('_')[1] === wrappedSolTokenAddress) {
                        //     sellTx = await sellToken(highestPoolData, buyTx.amountOut);
                        //     console.log("SELLTX LOW ===>", sellTx);
                        //     if (!sellTx) console.log("Sell_Base_Sol_error");
                        // } else {
                        //     sellTx = await buyToken(highestPoolData, buyTx.amountOut);
                        //     console.log("SELLTX HIGH ===>", sellTx);
                        //     if (!buyTx) console.log("Sell_Base_Token_error");
                        // }
                        // if (!buyTx || !sellTx) throw console.log("Error Transactions");

                        // buyTx = base58.encode(buyTx.transaction.serialize());
                        // sellTx = base58.encode(sellTx.transaction.serialize());
                        // const transactions = [buyTx, sellTx, tipTx];
                        // console.log("TX ======>", transactions);

                        // const result = await sendBundle(transactions);
                    } catch (error) {
                        console.error(chalk.red("❌ Error processing transaction:"), error);
                    }
                }
            }
        }
    }

    fs.writeFileSync(
        "opportunities.json",
        JSON.stringify(opportunities, null, 2)
    );
    console.log(
        chalk.green(
            `📊 Total number of profitable opportunities: ${opportunities.length}`
        )
    );

    if (opportunities.length > 0) {
        fs.appendFileSync(
            "profit_opportunities.log",
            `\nNew Opportunities Found: ${new Date().toISOString()}\n${JSON.stringify(
                opportunities,
                null,
                2
            )}`
        );
        console.log(chalk.green("📝 Logged new profit opportunities."));
    }

    setTimeout(fetchAndFilterAllPools, 3000);
};

fetchAndFilterAllPools();