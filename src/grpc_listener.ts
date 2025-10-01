import Client, { CommitmentLevel, SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import pumpIdl from "../IDL/pump.json"

dotenv.config();

//@ts-ignore
const coder = new BorshInstructionCoder(pumpIdl);



const ENDPOINT = process.env.GRPC_ENDPOINT!;
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";


const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);


interface Args {
   name: string
   data: {
    name: string
    symbol: string
    uri: string
    creator: PublicKey
   }
}

async function main() {
  console.log("Starting Pump.fun token listener...");
  
  const client = new Client(ENDPOINT,undefined,undefined);
  const stream = await client.subscribe();

  const request: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      pumpFun: {
        accountInclude: [PUMP_PROGRAM_ID],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    commitment: CommitmentLevel.FINALIZED,
    accountsDataSlice: [],
    ping: undefined,
  };

  stream.write(request);
  console.log("✓ Listening for new Pump.fun tokens...\n");

  stream.on("data", async (data: SubscribeUpdate) => {
    const transaction = data.transaction?.transaction;
    const message = transaction?.transaction?.message;
    
    if (!transaction || !message) return;


    // method one
    const createInstruction = message.instructions.find(ix => 
      ix.data && CREATE_DISCRIMINATOR.equals(ix.data.slice(0, 8))
    );

    
      // method two
    //     const createInstruction = message.instructions.find(ix => {
    //     const descrimnator = ix.data.slice(0,8);

    //    if(CREATE_DISCRIMINATOR.equals(descrimnator)){
    //     console.log("created-----")
    //    }
         
    // });
    if (!createInstruction) return;

    try {
      const tokenData = await parseTokenData(message, createInstruction, transaction, data);
      if (tokenData) {

      console.log("─".repeat(50));


       console.log("🚀 NEW TOKEN DETECTED FROM PUMPFUN THROUGH GRPC! ---");

        console.log(tokenData);

        // await SnipeToken(new PublicKey(tokenData.mint));

      console.log("LISTEINING FOR OHTERS TOKENS -------------- ");

        console.log("─".repeat(50));
      }
    } catch (error) {
      console.error("Error parsing token data:", error);
    }
  });

  stream.on("error", (error) => console.error("Stream error:", error));
  stream.on("end", () => console.log("Stream ended"));
}

async function parseTokenData(message: any, instruction: any, transaction: any, data: any) {
  try {
    const accountKeys = message.accountKeys;
    const accounts = instruction.accounts;
    
    // Extract account addresses
    const mint = new PublicKey(accountKeys[accounts[0]]).toBase58();
    const bonding_curve = new PublicKey(accountKeys[accounts[2]]).toBase58();
    const associated_bonding_curve = new PublicKey(accountKeys[accounts[3]]).toBase58();
    const user = new PublicKey(accountKeys[accounts[7]]).toBase58();


    const decoded = coder.decode(instruction.data, "base58");

    if (!decoded) {
        return null;
    }

    const args: Args = decoded as Args;

    return {
      signature: bs58.encode(Buffer.from(transaction.signature)),
      slot: data.transaction?.slot?.toString() || "",
      mint,
      name: args.data.name,
      uri: args.data.uri,
      symbol: args.data.symbol,
      creator: args.data.creator.toBase58(),
      bonding_curve,
      associated_bonding_curve,
      user,
    };
  } catch (error) {
    console.error("Error parsing token data:", error);
    return null;
  }
}


main().catch(console.error);