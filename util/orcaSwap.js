import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { connection, jito_tipaccounts, SLIPPAGE, wallet } from "../config.js";
import { buildWhirlpoolClient, IGNORE_CACHE, ORCA_WHIRLPOOL_PROGRAM_ID, swapQuoteByInputToken, WhirlpoolContext } from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";
import { DecimalUtil, isVersionedTransaction, Percentage } from "@orca-so/common-sdk";
import { convertBase64ToBase58, createTipTransaction, sendBundle } from "../jito.js";
import base58 from "bs58";
import { getTokenBalance } from "./getTokenBalance.js";
import { BN } from "bn.js";

export const orcaSwap = async(poolAddress, amount, isBuy, baseTokenAddress, baseTokenDecimal, quoteTokenAddress, quoteTokenDecimal) => {

    console.log("Orca In ===>", amount);
    var TokenA, TokenB, swapAmount
    if (baseTokenAddress === "So11111111111111111111111111111111111111112") {
        if (isBuy) {
            TokenA = {
                mint: baseTokenAddress,
                decimals: baseTokenDecimal
            }
            TokenB = {
                mint: quoteTokenAddress,
                decimals: quoteTokenDecimal
            }
        } else {
            TokenA = {
                mint: quoteTokenAddress,
                decimals: quoteTokenDecimal
            }
            TokenB = {
                mint: baseTokenAddress,
                decimals: baseTokenDecimal
            }
        }
    } else {
        if (isBuy) {
            TokenA = {
                mint: quoteTokenAddress,
                decimals: quoteTokenDecimal
            }
            TokenB = {
                mint: baseTokenAddress,
                decimals: baseTokenDecimal
            }
        } else {
            TokenA = {
                mint: baseTokenAddress,
                decimals: baseTokenDecimal
            }
            TokenB = {
                mint: quoteTokenAddress,
                decimals: quoteTokenDecimal
            }
        }
    }

    const ctx = WhirlpoolContext.from(
        connection,
        wallet,
        ORCA_WHIRLPOOL_PROGRAM_ID,
    )

    const whirlpoolClient = buildWhirlpoolClient(ctx);
    const whirlpool = await whirlpoolClient.getPool(new PublicKey(poolAddress));

    const amountIn = new Decimal(amount /* Token */ );
    // console.log(amountIn);
    if (isBuy) {
        swapAmount = DecimalUtil.toBN(amountIn, TokenA.decimals)
    } else {
        swapAmount = new BN(await getTokenBalance(wallet.publicKey.toString(), TokenA.mint))
    }
    const quote = await swapQuoteByInputToken(
        whirlpool,
        // Input token and amount
        TokenA.mint,
        swapAmount,
        // Acceptable slippage (10/1000 = 1%)
        Percentage.fromFraction(SLIPPAGE, 100),
        ctx.program.programId,
        ctx.fetcher,
        IGNORE_CACHE,
    );

    // Send the transaction
    const tx = await whirlpool.swap(quote, wallet.publicKey);
    const result = await tx.build()
    const txs = result.transaction
    txs.sign([wallet]);
    const resultTx = base58.encode(txs.serialize())
    const jitoTx = await createTipTransaction(wallet, connection);
    const tipTx = convertBase64ToBase58(jitoTx.serialize().toString('base64'));

    console.log("Orca Out ===>", Number(quote.estimatedAmountOut) / (10 ** TokenB.decimals));


    await sendBundle([resultTx, tipTx])

    if (isBuy) {
        while (1) {
            const balance = await getTokenBalance(wallet.publicKey.toString(), TokenB.mint.toString())
            if (balance >= Number(quote.estimatedAmountOut)) break;
        }
    }

    return {
        transaction: txs,
        amountOut: Number(quote.estimatedAmountOut) / (10 ** TokenB.decimals)
    };
}
