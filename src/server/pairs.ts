import type { TrackedPair } from "./types.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

export const TRACKED_PAIRS: TrackedPair[] = [
  {
    symbol: "MU",
    name: "Micron Technology",
    tokenMint: "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1",
    tokenDecimals: 6,
    perpSymbol: "MU.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "SNDK",
    name: "Sandisk",
    tokenMint: "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH",
    tokenDecimals: 6,
    perpSymbol: "SNDK.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "SPCX",
    name: "SpaceX",
    tokenMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    tokenDecimals: 6,
    perpSymbol: "SPCX.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "AMD",
    name: "Advanced Micro Devices",
    tokenMint: "AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES",
    tokenDecimals: 6,
    perpSymbol: "AMD.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "HOOD",
    name: "Robinhood Markets",
    tokenMint: "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A",
    tokenDecimals: 6,
    perpSymbol: "HOOD.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "INTC",
    name: "Intel",
    tokenMint: "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF",
    tokenDecimals: 6,
    perpSymbol: "INTC.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "SKHY",
    name: "SK Hynix",
    tokenMint: "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3",
    tokenDecimals: 6,
    perpSymbol: "SKHY.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "DRAM",
    name: "Roundhill Memory ETF",
    tokenMint: "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw",
    tokenDecimals: 6,
    perpSymbol: "DRAM.US_USDC_PERP",
    basisRisk: "same_issuer",
  },
  {
    symbol: "META",
    name: "Meta xStock",
    tokenMint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    tokenDecimals: 8,
    perpSymbol: "META.US_USDC_PERP",
    basisRisk: "cross_issuer",
  },
  {
    symbol: "MSFT",
    name: "Microsoft xStock",
    tokenMint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    tokenDecimals: 8,
    perpSymbol: "MSFT.US_USDC_PERP",
    basisRisk: "cross_issuer",
  },
  {
    symbol: "GOOGL",
    name: "Alphabet xStock",
    tokenMint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    tokenDecimals: 8,
    perpSymbol: "GOOGL.US_USDC_PERP",
    basisRisk: "cross_issuer",
  },
  {
    symbol: "QQQ",
    name: "Nasdaq 100 xStock",
    tokenMint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    tokenDecimals: 8,
    perpSymbol: "QQQ.US_USDC_PERP",
    basisRisk: "cross_issuer",
  },
  {
    symbol: "SPY",
    name: "S&P 500 xStock",
    tokenMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    tokenDecimals: 8,
    perpSymbol: "SPY.US_USDC_PERP",
    basisRisk: "cross_issuer",
  },
];


export const pairBySymbol = (symbol: string) =>
  TRACKED_PAIRS.find((pair) => pair.symbol === symbol);
