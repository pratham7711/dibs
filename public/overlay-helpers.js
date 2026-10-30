export function isPromotedRow(claim, promotedViewerId) {
  return Boolean(
    claim && promotedViewerId && claim.viewerId === promotedViewerId,
  );
}
