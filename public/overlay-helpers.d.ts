export interface OverlayClaim {
  viewerId: string;
}

export function isPromotedRow(
  claim: OverlayClaim | null | undefined,
  promotedViewerId: string | undefined,
): boolean;
