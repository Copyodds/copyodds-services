export type CopyTradingDispatchReason =
  | 'leader_signal_create'
  | 'leader_signal_redispatch'
  | 'replay'
  | 'manual';

export type CopyTradingDispatchPayload = {
  leaderTradeId: string;
  leaderAddress: string;
  occurredAt: string;
  reason?: CopyTradingDispatchReason;
  signalSource?: string;
  txHash?: string;
  logIndex?: number;
};

export type PublishCopyTradingDispatchInput = {
  leaderTradeId: string;
  leaderAddress: string;
  occurredAt?: string;
  reason?: CopyTradingDispatchReason;
  signalSource?: string;
  txHash?: string;
  logIndex?: number;
};
