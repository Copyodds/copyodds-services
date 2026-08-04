import { prisma } from '../../db';

/** 默认深度与节点上限，防止异常数据或恶意请求拖垮 DB */
export const DOWNLINE_SUBTREE_DEFAULTS = {
  maxDepth: 32,
  maxNodes: 5000,
} as const;

export type DownlineSubtreeRow = {
  id: number;
  /** 直接上级（在当前用户子树内指向父节点） */
  parentId: number;
  depth: number;
  username: string;
  inviteCode: string;
  affiliateTier: number | null;
};

/**
 * 使用 PostgreSQL 递归 CTE 拉取某用户之下全部多级下属（邻接表 referrerId）。
 * 单次往返、按深度与 id 稳定排序；超过 maxNodes 时截断并标记 truncated。
 */
export async function queryDownlineSubtree(
  rootUserId: number,
  options: { maxDepth: number; maxNodes: number },
): Promise<{ rows: DownlineSubtreeRow[]; truncated: boolean }> {
  const { maxDepth, maxNodes } = options;
  const limit = maxNodes + 1;

  const raw = await prisma.$queryRaw<
    Array<{
      id: number;
      referrerId: number | null;
      depth: number;
      username: string;
      inviteCode: string;
      affiliateTier: number | null;
    }>
  >`
    WITH RECURSIVE subtree AS (
      SELECT
        u.id,
        u."referrerId",
        u.username,
        u."inviteCode",
        u."affiliateTier",
        1 AS depth
      FROM "User" u
      WHERE u."referrerId" = ${rootUserId}

      UNION ALL

      SELECT
        u.id,
        u."referrerId",
        u.username,
        u."inviteCode",
        u."affiliateTier",
        s.depth + 1
      FROM "User" u
      INNER JOIN subtree s ON u."referrerId" = s.id
      WHERE s.depth < ${maxDepth}
    )
    SELECT id, "referrerId", depth, username, "inviteCode", "affiliateTier"
    FROM subtree
    ORDER BY depth ASC, id ASC
    LIMIT ${limit}
  `;

  const truncated = raw.length > maxNodes;
  const slice = truncated ? raw.slice(0, maxNodes) : raw;

  const rows: DownlineSubtreeRow[] = slice.map((r) => ({
    id: r.id,
    parentId: r.referrerId ?? rootUserId,
    depth: r.depth,
    username: r.username,
    inviteCode: r.inviteCode,
    affiliateTier: r.affiliateTier,
  }));

  return { rows, truncated };
}
