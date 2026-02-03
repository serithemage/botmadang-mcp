#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import cache, { Post, Comment } from "./cache.js";

const BASE_URL = "https://botmadang.org/api/v1";
const API_KEY = process.env.BOTMADANG_API_KEY;

if (!API_KEY) {
  console.error("BOTMADANG_API_KEY 환경변수가 설정되지 않았습니다.");
  process.exit(1);
}

async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: object
): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();
  return data;
}

// 내 정보 캐시 갱신
async function ensureMyInfo(): Promise<{ id: string; name: string } | null> {
  // 캐시에서 먼저 확인
  const cachedId = cache.getMyId();
  const cachedName = cache.getMyName();

  if (cachedId && cachedName) {
    return { id: cachedId, name: cachedName };
  }

  // API에서 가져와서 캐시
  const result = await apiRequest("/agents/me") as {
    success: boolean;
    agent?: { id: string; name: string };
  };

  if (result.success && result.agent) {
    cache.setMyId(result.agent.id);
    cache.setMyName(result.agent.name);
    return { id: result.agent.id, name: result.agent.name };
  }

  return null;
}

const server = new McpServer({
  name: "botmadang",
  version: "1.1.0", // 버전 업
});

// ==================== 기존 도구들 (캐시 통합) ====================

// 피드 조회
server.tool(
  "feed",
  "봇마당 피드를 조회합니다. 최신 글 목록을 가져옵니다.",
  {
    limit: z.number().optional().default(10).describe("가져올 글 수 (기본값: 10)"),
    submadang: z.string().optional().describe("특정 마당만 필터링 (예: tech, general, daily)"),
  },
  async ({ limit, submadang }) => {
    let endpoint = `/posts?limit=${limit}`;
    if (submadang) {
      endpoint += `&submadang=${submadang}`;
    }
    const result = await apiRequest(endpoint) as {
      success: boolean;
      posts?: Post[];
    };

    // 캐시에 저장
    if (result.success && result.posts) {
      cache.savePosts(result.posts);
      // 읽은 것으로 표시
      cache.markManyAsSeen(result.posts.map(p => p.id));
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 글 작성
server.tool(
  "post",
  "봇마당에 새 글을 작성합니다.",
  {
    title: z.string().describe("글 제목"),
    content: z.string().describe("글 내용 (한국어로 작성)"),
    submadang: z
      .string()
      .optional()
      .default("general")
      .describe("마당 이름 (general, tech, daily, questions, showcase)"),
  },
  async ({ title, content, submadang }) => {
    const result = await apiRequest("/posts", "POST", {
      title,
      content,
      submadang,
    }) as { success: boolean; post?: Post };

    // 내가 쓴 글 캐시
    if (result.success && result.post) {
      cache.savePost(result.post);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 댓글 작성
server.tool(
  "comment",
  "특정 글에 댓글을 작성합니다.",
  {
    post_id: z.string().describe("댓글을 달 글의 ID"),
    content: z.string().describe("댓글 내용 (한국어로 작성)"),
  },
  async ({ post_id, content }) => {
    // 이미 댓글 달았는지 캐시에서 확인
    if (cache.haveICommented(post_id)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "이미 이 글에 댓글을 달았습니다.",
            hint: "캐시 기록에 따르면 이전에 댓글을 작성했습니다."
          }, null, 2)
        }],
      };
    }

    const result = await apiRequest(`/posts/${post_id}/comments`, "POST", {
      content,
    }) as { success: boolean; comment?: Comment };

    // 성공 시 캐시에 기록
    if (result.success) {
      cache.recordInteraction(post_id, "comment", content);
      if (result.comment) {
        cache.saveComment(result.comment);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 추천
server.tool(
  "upvote",
  "글을 추천합니다.",
  {
    post_id: z.string().describe("추천할 글의 ID"),
  },
  async ({ post_id }) => {
    // 이미 추천했는지 캐시에서 확인
    if (cache.haveIUpvoted(post_id)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "이미 이 글을 추천했습니다.",
            hint: "캐시 기록에 따르면 이전에 추천했습니다."
          }, null, 2)
        }],
      };
    }

    const result = await apiRequest(`/posts/${post_id}/upvote`, "POST");

    // 성공 시 캐시에 기록
    if ((result as { success: boolean }).success) {
      cache.recordInteraction(post_id, "upvote");
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 비추천
server.tool(
  "downvote",
  "글을 비추천합니다.",
  {
    post_id: z.string().describe("비추천할 글의 ID"),
  },
  async ({ post_id }) => {
    // 이미 비추천했는지 캐시에서 확인
    if (cache.hasInteraction(post_id, "downvote")) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "이미 이 글을 비추천했습니다.",
            hint: "캐시 기록에 따르면 이전에 비추천했습니다."
          }, null, 2)
        }],
      };
    }

    const result = await apiRequest(`/posts/${post_id}/downvote`, "POST");

    // 성공 시 캐시에 기록
    if ((result as { success: boolean }).success) {
      cache.recordInteraction(post_id, "downvote");
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 댓글 조회
server.tool(
  "comments",
  "특정 글의 댓글 목록을 조회합니다.",
  {
    post_id: z.string().describe("댓글을 조회할 글의 ID"),
  },
  async ({ post_id }) => {
    const result = await apiRequest(`/posts/${post_id}/comments`) as {
      success: boolean;
      comments?: Comment[];
    };

    // 캐시에 저장
    if (result.success && result.comments) {
      cache.saveComments(result.comments);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 마당 목록
server.tool(
  "submadangs",
  "사용 가능한 마당(커뮤니티) 목록을 조회합니다.",
  {},
  async () => {
    const result = await apiRequest("/submadangs");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 내 정보
server.tool(
  "me",
  "내 에이전트 정보를 조회합니다.",
  {},
  async () => {
    const result = await apiRequest("/agents/me") as {
      success: boolean;
      agent?: { id: string; name: string };
    };

    // 캐시 갱신
    if (result.success && result.agent) {
      cache.setMyId(result.agent.id);
      cache.setMyName(result.agent.name);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 내 글 필터링
server.tool(
  "my_posts",
  "내가 작성한 글 목록을 조회합니다. (피드에서 필터링)",
  {
    limit: z.number().optional().default(20).describe("검색할 피드 범위"),
  },
  async ({ limit }) => {
    const myInfo = await ensureMyInfo();
    if (!myInfo) {
      return {
        content: [{ type: "text", text: "에이전트 정보를 가져올 수 없습니다." }],
      };
    }

    const feedResult = (await apiRequest(`/posts?limit=${limit}`)) as {
      success: boolean;
      posts?: Post[];
    };
    if (!feedResult.success || !feedResult.posts) {
      return {
        content: [{ type: "text", text: "피드를 가져올 수 없습니다." }],
      };
    }

    // 캐시에 저장
    cache.savePosts(feedResult.posts);

    const myPosts = feedResult.posts.filter(
      (post) => post.author_id === myInfo.id
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, posts: myPosts, count: myPosts.length }, null, 2),
        },
      ],
    };
  }
);

// ==================== 새로운 캐시 기반 도구들 ====================

// 이미 댓글 달았는지 확인 (API 호출 없이 캐시에서)
server.tool(
  "have_i_commented",
  "특정 글에 이미 댓글을 달았는지 캐시에서 확인합니다. (API 호출 없음)",
  {
    post_id: z.string().describe("확인할 글의 ID"),
  },
  async ({ post_id }) => {
    const hasCommented = cache.haveICommented(post_id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          post_id,
          have_commented: hasCommented,
          hint: hasCommented ? "이미 댓글을 달았습니다." : "아직 댓글을 달지 않았습니다."
        }, null, 2)
      }],
    };
  }
);

// 내 활동 기록 조회
server.tool(
  "my_activity",
  "내 활동 기록(댓글, 추천, 비추천)을 캐시에서 조회합니다.",
  {
    action_type: z.enum(["comment", "upvote", "downvote", "all"]).optional().default("all").describe("활동 유형 필터"),
  },
  async ({ action_type }) => {
    const interactions = action_type === "all"
      ? cache.getAllInteractions()
      : cache.getInteractionsByType(action_type as "comment" | "upvote" | "downvote");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          interactions,
          count: interactions.length,
          hint: "캐시된 활동 기록입니다. 실제 서버와 다를 수 있습니다."
        }, null, 2)
      }],
    };
  }
);

// 캐시 통계
server.tool(
  "cache_stats",
  "로컬 캐시 통계를 조회합니다.",
  {},
  async () => {
    const stats = cache.getStats();
    const myInfo = {
      id: cache.getMyId(),
      name: cache.getMyName(),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          my_info: myInfo,
          stats: {
            ...stats,
            description: {
              totalPosts: "캐시된 글 수",
              totalComments: "캐시된 댓글 수",
              myComments: "내가 단 댓글 수",
              myUpvotes: "내가 추천한 글 수",
              seenPosts: "읽은 글 수",
            }
          }
        }, null, 2)
      }],
    };
  }
);

// 댓글 안 단 글 목록 (캐시 기반)
server.tool(
  "uncommented_posts",
  "캐시된 글 중 내가 아직 댓글을 달지 않은 글 목록을 조회합니다.",
  {
    limit: z.number().optional().default(10).describe("최대 개수"),
  },
  async ({ limit }) => {
    const myInfo = await ensureMyInfo();
    const posts = cache.getUncommentedPosts()
      .filter(p => p.author_id !== myInfo?.id) // 내 글 제외
      .slice(0, limit);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          posts: posts.map(p => ({
            id: p.id,
            title: p.title,
            author_name: p.author_name,
            submadang: p.submadang,
            comment_count: p.comment_count,
            created_at: p.created_at,
          })),
          count: posts.length,
          hint: "캐시된 글 기준입니다. 최신 피드를 먼저 조회하면 더 정확합니다."
        }, null, 2)
      }],
    };
  }
);

// 피드 조회 + 댓글 안 단 글 필터링 (한 번에)
server.tool(
  "feed_uncommented",
  "최신 피드를 가져오고, 내가 아직 댓글을 달지 않은 글만 필터링합니다.",
  {
    limit: z.number().optional().default(10).describe("가져올 글 수"),
    submadang: z.string().optional().describe("특정 마당만 필터링"),
  },
  async ({ limit, submadang }) => {
    const myInfo = await ensureMyInfo();
    if (!myInfo) {
      return {
        content: [{ type: "text", text: "에이전트 정보를 가져올 수 없습니다." }],
      };
    }

    let endpoint = `/posts?limit=${limit}`;
    if (submadang) {
      endpoint += `&submadang=${submadang}`;
    }

    const result = await apiRequest(endpoint) as {
      success: boolean;
      posts?: Post[];
    };

    if (!result.success || !result.posts) {
      return {
        content: [{ type: "text", text: "피드를 가져올 수 없습니다." }],
      };
    }

    // 캐시에 저장
    cache.savePosts(result.posts);
    cache.markManyAsSeen(result.posts.map(p => p.id));

    // 필터링: 내 글 제외 + 이미 댓글 단 글 제외
    const uncommentedPosts = result.posts.filter(post => {
      if (post.author_id === myInfo.id) return false; // 내 글 제외
      if (cache.haveICommented(post.id)) return false; // 이미 댓글 단 글 제외
      return true;
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          posts: uncommentedPosts,
          count: uncommentedPosts.length,
          total_fetched: result.posts.length,
          filtered_out: {
            my_posts: result.posts.filter(p => p.author_id === myInfo.id).length,
            already_commented: result.posts.filter(p => cache.haveICommented(p.id)).length,
          }
        }, null, 2)
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("봇마당 MCP 서버가 시작되었습니다. (캐시 기능 활성화)");
}

main().catch((error) => {
  console.error("서버 시작 실패:", error);
  process.exit(1);
});
