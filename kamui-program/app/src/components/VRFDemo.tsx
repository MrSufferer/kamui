import { useState, useCallback, useRef } from 'react';
import type { FC } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SystemProgram, Keypair, TransactionInstruction } from '@solana/web3.js';

// Program IDs from the deployed contracts
const KAMUI_VRF_PROGRAM_ID = new PublicKey('6k1Lmt37b5QQAhPz5YXbTPoHCSCDbSEeNAC96nWZn85a');

// Request status enum
type RequestStatus = 'idle' | 'submitting' | 'waiting' | 'fulfilled' | 'timeout' | 'error';

// Configuration
const VRF_TIMEOUT_MS = 60000; // 60 seconds timeout
const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds

// Helper function to generate random bytes using Web Crypto API
const generateRandomBytes = (length: number): Uint8Array => {
    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);
    return array;
};

// Helper function to create a hash using Web Crypto API
const sha256 = async (data: string): Promise<Uint8Array> => {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', encodedData);
    return new Uint8Array(hashBuffer);
};

// Serialization helpers (browser-compatible)
const serializeU64 = (value: bigint): Uint8Array => {
    const buffer = new Uint8Array(8);
    let val = value;
    for (let i = 0; i < 8; i++) {
        buffer[i] = Number(val & BigInt(0xFF));
        val = val >> BigInt(8);
    }
    return buffer;
};

const serializeU32 = (value: number): Uint8Array => {
    const buffer = new Uint8Array(4);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, value, true); // little-endian
    return buffer;
};

const serializeU16 = (value: number): Uint8Array => {
    const buffer = new Uint8Array(2);
    const view = new DataView(buffer.buffer);
    view.setUint16(0, value, true); // little-endian
    return buffer;
};

// Helper to concatenate Uint8Arrays
const concatUint8Arrays = (...arrays: Uint8Array[]): Uint8Array => {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
};

const VRFDemo: FC = () => {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [status, setStatus] = useState<RequestStatus>('idle');
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [timeRemaining, setTimeRemaining] = useState<number>(0);
    const abortRef = useRef<boolean>(false);

    /**
     * Wait for VRF fulfillment with timeout (similar to integration test pattern)
     */
    const waitForFulfillment = useCallback(async (
        requestPubkey: PublicKey
    ): Promise<string | null> => {
        const startTime = Date.now();
        abortRef.current = false;

        // Derive VRF result PDA using request account pubkey (matches standalone server)
        const [vrfResultPDA] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('vrf_result'), requestPubkey.toBuffer()],
            KAMUI_VRF_PROGRAM_ID
        );

        console.log(`🔍 Polling for VRF result at: ${vrfResultPDA.toString()}`);
        console.log(`📋 Request account: ${requestPubkey.toString()}`);

        while (!abortRef.current) {
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, VRF_TIMEOUT_MS - elapsed);
            setTimeRemaining(Math.ceil(remaining / 1000));

            if (elapsed >= VRF_TIMEOUT_MS) {
                console.log('⏰ VRF fulfillment timeout');
                return null;
            }

            try {
                // Check if VRF result account exists (indicates fulfillment)
                const resultAccount = await connection.getAccountInfo(vrfResultPDA);

                if (resultAccount && resultAccount.data.length > 12) {
                    // VRF result account exists - extract the random output
                    // VrfResult layout: [8 discriminator][4 vec_len][64 bytes * len for randomness]...
                    const data = resultAccount.data;
                    const vecLen = new DataView(data.buffer).getUint32(8, true); // little-endian

                    if (vecLen > 0 && data.length >= 12 + 64) {
                        // Read the first 64-byte random output (after discriminator + vec_len)
                        const randomOutput = data.slice(12, 12 + 64);
                        const hexResult = Array.from(randomOutput)
                            .map(b => b.toString(16).padStart(2, '0'))
                            .join('');
                        console.log(`✅ VRF fulfilled! Output: ${hexResult.substring(0, 32)}...`);
                        return hexResult;
                    }
                }

                // Also check request account status
                const requestAccount = await connection.getAccountInfo(requestPubkey);
                if (requestAccount && requestAccount.data.length > 108) {
                    // Parse status field from request account
                    // Skip: discriminator(8) + subscription(32) + seed(32) + requester(32) + callback_data_len(4) = 108
                    const callbackLen = new DataView(requestAccount.data.buffer).getUint32(104, true);
                    const statusOffset = 108 + callbackLen + 8; // +8 for request_slot

                    if (statusOffset < requestAccount.data.length) {
                        const requestStatus = requestAccount.data[statusOffset];
                        // RequestStatus::Fulfilled = 1
                        if (requestStatus === 1) {
                            console.log('✅ Request marked as fulfilled');
                            // Try to get the result again
                            const resultAccount2 = await connection.getAccountInfo(vrfResultPDA);
                            if (resultAccount2 && resultAccount2.data.length >= 12 + 64) {
                                const randomOutput = resultAccount2.data.slice(12, 12 + 64);
                                const hexResult = Array.from(randomOutput)
                                    .map(b => b.toString(16).padStart(2, '0'))
                                    .join('');
                                console.log(`✅ Got result: ${hexResult.substring(0, 32)}...`);
                                return hexResult;
                            }
                        }
                    }
                }

            } catch (err) {
                console.log('Polling error (retrying):', err);
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return null;
    }, [connection]);

    const requestRandomness = useCallback(async () => {
        if (!publicKey || !sendTransaction) {
            setError('Please connect your wallet first');
            return;
        }

        try {
            setStatus('submitting');
            setError(null);
            setResult(null);
            abortRef.current = false;

            // Generate a unique seed for the request
            const seed = generateRandomBytes(32);
            console.log('Request seed:', Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join(''));

            // Create a new request account keypair
            const requestKeypair = Keypair.generate();
            console.log('Request account:', requestKeypair.publicKey.toString());

            // Find subscription PDA using a unique seed
            const uniqueSeedString = `kamui-vrf-${publicKey.toString()}-${Date.now()}`;
            const seedHash = await sha256(uniqueSeedString);
            const subscriptionSeed = Keypair.fromSeed(seedHash.slice(0, 32));

            const [subscriptionPDA] = PublicKey.findProgramAddressSync(
                [new TextEncoder().encode('subscription'), subscriptionSeed.publicKey.toBuffer()],
                KAMUI_VRF_PROGRAM_ID
            );

            // Find request pool PDA
            const [requestPoolPDA] = PublicKey.findProgramAddressSync(
                [
                    new TextEncoder().encode('request_pool'),
                    subscriptionPDA.toBuffer(),
                    new Uint8Array([0]) // pool_id = 0
                ],
                KAMUI_VRF_PROGRAM_ID
            );

            // Create subscription instruction
            const minBalance = BigInt(10_000_000); // 0.01 SOL
            const createSubscriptionData = concatUint8Arrays(
                new Uint8Array([75, 228, 93, 239, 254, 201, 220, 235]), // discriminator
                serializeU64(minBalance),
                new Uint8Array([3]), // confirmations
                serializeU16(10) // max_requests
            );

            const createSubscriptionIx = new TransactionInstruction({
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
                    { pubkey: subscriptionSeed.publicKey, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: KAMUI_VRF_PROGRAM_ID,
                data: Buffer.from(createSubscriptionData),
            });

            // Fund subscription instruction
            const fundingAmount = BigInt(50_000_000); // 0.05 SOL
            const fundData = concatUint8Arrays(
                new Uint8Array([224, 196, 55, 110, 8, 87, 188, 114]), // discriminator
                serializeU64(fundingAmount)
            );

            const fundIx = new TransactionInstruction({
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: KAMUI_VRF_PROGRAM_ID,
                data: Buffer.from(fundData),
            });

            // Initialize request pool instruction
            const initPoolData = concatUint8Arrays(
                new Uint8Array([179, 102, 255, 254, 232, 62, 64, 97]), // discriminator
                new Uint8Array([0]), // pool_id
                serializeU32(100) // max_size
            );

            const initPoolIx = new TransactionInstruction({
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
                    { pubkey: requestPoolPDA, isSigner: false, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: KAMUI_VRF_PROGRAM_ID,
                data: Buffer.from(initPoolData),
            });

            // Request randomness instruction
            const requestData = concatUint8Arrays(
                new Uint8Array([213, 5, 173, 166, 37, 236, 31, 18]), // discriminator
                seed,
                serializeU32(0), // callback_data length (empty)
                serializeU32(1), // num_words
                new Uint8Array([1]), // minimum_confirmations
                serializeU64(BigInt(100000)), // callback_gas_limit
                new Uint8Array([0]), // pool_id
            );

            const requestIx = new TransactionInstruction({
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: requestKeypair.publicKey, isSigner: true, isWritable: true },
                    { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
                    { pubkey: requestPoolPDA, isSigner: false, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: KAMUI_VRF_PROGRAM_ID,
                data: Buffer.from(requestData),
            });

            // Get recent blockhash
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

            // Create transaction
            const tx = new Transaction({
                feePayer: publicKey,
                blockhash,
                lastValidBlockHeight,
            }).add(
                createSubscriptionIx,
                fundIx,
                initPoolIx,
                requestIx
            );

            // Partially sign with request keypair only (subscriptionSeed is just for PDA derivation, not a signer)
            tx.partialSign(requestKeypair);

            // Send transaction
            const signature = await sendTransaction(tx, connection, {
                skipPreflight: true
            });

            console.log('📤 Transaction submitted:', signature);

            // Wait for confirmation
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight,
            });

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log('✅ Transaction confirmed:', signature);
            console.log(`🔗 Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

            // Now wait for VRF fulfillment
            setStatus('waiting');
            setTimeRemaining(Math.ceil(VRF_TIMEOUT_MS / 1000));

            const vrfResult = await waitForFulfillment(requestKeypair.publicKey);

            if (vrfResult) {
                setStatus('fulfilled');
                setResult(vrfResult);
            } else {
                setStatus('timeout');
                setError('VRF fulfillment timed out. Make sure the VRF server is running.');
            }

        } catch (err) {
            console.error('Error requesting randomness:', err);
            setStatus('error');

            let errorMessage = 'An error occurred';
            if (err instanceof Error) {
                errorMessage = err.message;
            } else if (typeof err === 'object' && err !== null) {
                errorMessage = JSON.stringify(err, null, 2);
            }
            setError(errorMessage);
        }
    }, [publicKey, connection, sendTransaction, waitForFulfillment]);

    const cancelRequest = useCallback(() => {
        abortRef.current = true;
        setStatus('idle');
    }, []);

    const getStatusText = (): string => {
        switch (status) {
            case 'submitting':
                return 'Submitting request to blockchain...';
            case 'waiting':
                return `Waiting for VRF server to process... (${timeRemaining}s remaining)`;
            case 'fulfilled':
                return 'Random number generated!';
            case 'timeout':
                return 'Request timed out';
            case 'error':
                return 'Error occurred';
            default:
                return '';
        }
    };

    const isLoading = status === 'submitting' || status === 'waiting';

    return (
        <div className="max-w-2xl mx-auto bg-white/10 rounded-xl p-8 backdrop-blur-lg">
            <div className="text-center mb-8">
                <h2 className="text-2xl font-bold mb-4">Verifiable Random Function Demo</h2>
                <p className="text-gray-300 mb-6">
                    Generate provably fair random numbers using Solana's VRF system
                </p>

                <div className="flex justify-center gap-4">
                    <button
                        onClick={requestRandomness}
                        disabled={isLoading || !publicKey}
                        className={`
                            px-6 py-3 rounded-lg font-semibold text-lg
                            ${isLoading
                                ? 'bg-purple-500 cursor-not-allowed'
                                : 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800'}
                            transition-colors duration-200
                        `}
                    >
                        {isLoading ? 'Processing...' : 'Generate Random Number'}
                    </button>

                    {status === 'waiting' && (
                        <button
                            onClick={cancelRequest}
                            className="px-6 py-3 rounded-lg font-semibold text-lg bg-red-600 hover:bg-red-700 transition-colors duration-200"
                        >
                            Cancel
                        </button>
                    )}
                </div>

                {status !== 'idle' && (
                    <div className={`mt-4 p-3 rounded-lg ${status === 'fulfilled' ? 'bg-green-900/20 text-green-400' :
                        status === 'error' || status === 'timeout' ? 'bg-red-900/20 text-red-400' :
                            'bg-blue-900/20 text-blue-400'
                        }`}>
                        {getStatusText()}
                        {status === 'waiting' && (
                            <div className="mt-2">
                                <div className="w-full bg-gray-700 rounded-full h-2">
                                    <div
                                        className="bg-purple-500 h-2 rounded-full transition-all duration-1000"
                                        style={{ width: `${(timeRemaining / (VRF_TIMEOUT_MS / 1000)) * 100}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {error && status === 'error' && (
                    <div className="mt-4 text-red-400 bg-red-900/20 rounded-lg p-3">
                        {error}
                    </div>
                )}

                {result !== null && status === 'fulfilled' && (() => {
                    // Convert hex to BigInt for calculations
                    const fullHex = result;
                    const bigIntValue = BigInt('0x' + fullHex.substring(0, 16)); // Use first 64 bits

                    // Generate human-readable numbers
                    const maxU64 = BigInt('18446744073709551615');
                    const humanNumber = Number((bigIntValue % BigInt(1000000)) + BigInt(1)); // 1 to 1,000,000
                    const percentage = Number((bigIntValue * BigInt(10000) / maxU64)) / 100; // 0.00% to 100.00%
                    const diceRoll = Number((bigIntValue % BigInt(6)) + BigInt(1)); // 1 to 6
                    const coinFlip = bigIntValue % BigInt(2) === BigInt(0) ? 'Heads' : 'Tails';

                    return (
                        <div className="mt-8 space-y-6">
                            {/* Primary Display - Human Readable Number */}
                            <div className="text-center">
                                <h3 className="text-lg text-gray-300 mb-2">Your Random Number</h3>
                                <div className="text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-400 to-purple-400 animate-pulse">
                                    {humanNumber.toLocaleString()}
                                </div>
                                <p className="text-sm text-gray-400 mt-1">Range: 1 - 1,000,000</p>
                            </div>

                            {/* Fun Examples */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-white/5 rounded-lg p-4 text-center">
                                    <div className="text-3xl mb-1">🎲</div>
                                    <div className="text-2xl font-bold text-purple-300">{diceRoll}</div>
                                    <p className="text-xs text-gray-400">Dice Roll (1-6)</p>
                                </div>
                                <div className="bg-white/5 rounded-lg p-4 text-center">
                                    <div className="text-3xl mb-1">{coinFlip === 'Heads' ? '🪙' : '💫'}</div>
                                    <div className="text-2xl font-bold text-pink-300">{coinFlip}</div>
                                    <p className="text-xs text-gray-400">Coin Flip</p>
                                </div>
                            </div>

                            {/* Percentage Bar */}
                            <div className="bg-white/5 rounded-lg p-4">
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-gray-400">Randomness Position</span>
                                    <span className="text-purple-300 font-mono">{percentage.toFixed(2)}%</span>
                                </div>
                                <div className="w-full bg-gray-700 rounded-full h-3">
                                    <div
                                        className="bg-gradient-to-r from-purple-500 to-pink-500 h-3 rounded-full transition-all duration-500"
                                        style={{ width: `${percentage}%` }}
                                    />
                                </div>
                            </div>

                            {/* Technical Details (Collapsible) */}
                            <details className="bg-white/5 rounded-lg p-4">
                                <summary className="text-sm text-gray-400 cursor-pointer hover:text-gray-300">
                                    🔍 View Full 256-bit VRF Output
                                </summary>
                                <div className="mt-3 font-mono text-xs text-purple-300 break-all bg-black/20 p-3 rounded">
                                    0x{fullHex}
                                </div>
                                <p className="text-xs text-gray-500 mt-2">
                                    This is the cryptographically verifiable random output from the VRF.
                                </p>
                            </details>
                        </div>
                    );
                })()}
            </div>

            <div className="border-t border-white/10 pt-6 mt-6">
                <h3 className="text-lg font-semibold mb-3">How it works:</h3>
                <ol className="list-decimal list-inside space-y-2 text-gray-300">
                    <li>Connect your wallet to get started</li>
                    <li>Click "Generate Random Number" to submit a request</li>
                    <li>The VRF server generates a verifiable random proof</li>
                    <li>The result is stored on-chain and displayed here</li>
                </ol>
                <p className="mt-4 text-sm text-gray-400">
                    Note: Requires the standalone VRF server to be running for fulfillment.
                </p>
            </div>
        </div>
    );
};

export default VRFDemo;