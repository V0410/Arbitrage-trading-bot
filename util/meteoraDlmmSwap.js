import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { connection, SLIPPAGE, wallet } from "../config.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import { Wallet } from "@project-serum/anchor";
import { convertBase64ToBase58, createTipTransaction, sendBundle } from "../jito.js";
import base58 from "bs58";
import { getTokenBalance } from './getTokenBalance.js'

export const meteoraDlmmSwap = async(poolAddress, amount, isBuy, baseTokenAddress, baseTokenDecimal, quoteTokenAddress, quoteTokenDecimal) => {
    const dlmmPool = await DLMM.default.create(connection, new PublicKey(poolAddress))
    var swapAmount;
    var swapOpt;
    var swapYtoX;
    var decimal, decimal1;
    console.log("Meteora DLMM In ===>", amount);

    if (baseTokenAddress === "So11111111111111111111111111111111111111112") {
        if (isBuy) {
            decimal = baseTokenDecimal
            decimal1 = quoteTokenDecimal
            swapYtoX = false;
            swapAmount = new BN(amount * 10 ** baseTokenDecimal)
        } else {
            decimal = quoteTokenDecimal
            decimal1 = baseTokenDecimal
            swapYtoX = true;
            swapAmount = new BN(await getTokenBalance(wallet.publicKey.toString(), quoteTokenAddress))
        }
    } else {
        if (isBuy) {
            decimal = quoteTokenDecimal
            decimal1 = baseTokenDecimal
            swapYtoX = true;
            swapAmount = new BN(amount * 10 ** quoteTokenDecimal)
        } else {
            decimal = baseTokenDecimal
            decimal1 = quoteTokenDecimal
            swapYtoX = false;
            swapAmount = new BN(await getTokenBalance(wallet.publicKey.toString(), baseTokenAddress))
        }
    }

    // Swap quote
    const binArrays = await dlmmPool.getBinArrayForSwap(swapYtoX);

    const swapQuote = await dlmmPool.swapQuote(swapAmount, swapYtoX, new BN(SLIPPAGE), binArrays);

    if (baseTokenAddress === "So11111111111111111111111111111111111111112") {
        if (isBuy) {
            swapAmount = new BN(amount * 10 ** baseTokenDecimal)
            swapOpt = {
                inToken: dlmmPool.tokenX.publicKey,
                binArraysPubkey: swapQuote.binArraysPubkey,
                inAmount: swapAmount,
                lbPair: dlmmPool.pubkey,
                user: wallet.publicKey,
                minOutAmount: swapQuote.minOutAmount,
                outToken: dlmmPool.tokenY.publicKey,
            }
        } else {
            swapAmount = new BN(amount * 10 ** quoteTokenDecimal);
            swapOpt = {
                inToken: dlmmPool.tokenY.publicKey,
                binArraysPubkey: swapQuote.binArraysPubkey,
                inAmount: swapAmount,
                lbPair: dlmmPool.pubkey,
                user: wallet.publicKey,
                minOutAmount: swapQuote.minOutAmount,
                outToken: dlmmPool.tokenY.publicKey,
            }
        }
    } else {
        if (isBuy) {
            swapAmount = new BN(amount * 10 ** quoteTokenDecimal)
            swapOpt = {
                inToken: dlmmPool.tokenY.publicKey,
                binArraysPubkey: swapQuote.binArraysPubkey,
                inAmount: swapAmount,
                lbPair: dlmmPool.pubkey,
                user: wallet.publicKey,
                minOutAmount: swapQuote.minOutAmount,
                outToken: dlmmPool.tokenY.publicKey,
            }
        } else {
            swapAmount = new BN(amount * 10 ** baseTokenDecimal);
            swapOpt = {
                inToken: dlmmPool.tokenX.publicKey,
                binArraysPubkey: swapQuote.binArraysPubkey,
                inAmount: swapAmount,
                lbPair: dlmmPool.pubkey,
                user: wallet.publicKey,
                minOutAmount: swapQuote.minOutAmount,
                outToken: dlmmPool.tokenY.publicKey,
            }
        }
    }
    // console.log("🚀 ~ swapQuote:", swapOpt);

    // Swap
    const swapTx = await dlmmPool.swap(swapOpt);

    await swapTx.sign(wallet);

    // const signature = await connection.sendTransaction(swapTx, [wallet]);
    // await connection.confirmTransaction(signature, 'confirmed');

    const resultTx = base58.encode(swapTx.serialize())
    const jitoTx = await createTipTransaction(wallet, connection);
    const tipTx = convertBase64ToBase58(jitoTx.serialize().toString('base64'));
    console.log("Meteora DLMM Out ===>", Number(swapQuote.minOutAmount));

    await sendBundle([resultTx, tipTx])

    if (isBuy) {
        while (1) {
            const balance = await getTokenBalance(wallet.publicKey.toString(), swapOpt.outToken.toString())
            if (balance >= Number(swapQuote.minOutAmount) / 2) break;
        }
    }

    // console.log("ilfdhuioawhyfuieydufioyusi ======>", swapTx);
    //https://solana.com/developers/cookbook/transactions/add-priority-fees
    // set the desired priority fee
    return { transaction: swapTx, amountOut: Number(swapQuote.minOutAmount) }
}