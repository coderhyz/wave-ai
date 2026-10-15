/** 只检查编号归属；不证明引用支持论断。 */
export function verifyCitationIds(
  report: string,
  sourceIds: ReadonlySet<string>
) {
  const citedIds = [
    ...new Set(
      [...report.matchAll(/(?<!\\)\[(S\d+)\]/g)].map((match) => match[1])
    ),
  ]
  const invalidIds = citedIds.filter((id) => !sourceIds.has(id))
  return {
    valid: invalidIds.length === 0,
    citedIds,
    invalidIds,
    supportVerified: false as const,
  }
}
