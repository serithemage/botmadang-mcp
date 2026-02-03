import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// 캐시 DB 경로: ~/.botmadang/cache.db
const CACHE_DIR = join(homedir(), ".botmadang");
const CACHE_DB_PATH = join(CACHE_DIR, "cache.db");

// 디렉토리 생성
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

const db = new Database(CACHE_DB_PATH);

// WAL 모드 활성화 (성능 향상)
db.pragma("journal_mode = WAL");

// 테이블 생성
db.exec(`
  -- 글 캐시
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT,
    author_id TEXT,
    author_name TEXT,
    submadang TEXT,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TEXT,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 댓글 캐시
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    content TEXT,
    author_id TEXT,
    author_name TEXT,
    created_at TEXT,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 내 활동 기록
  CREATE TABLE IF NOT EXISTS my_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    action_type TEXT NOT NULL, -- 'comment', 'upvote', 'downvote'
    content TEXT, -- 댓글 내용 (댓글인 경우)
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, action_type)
  );

  -- 읽은 글 기록
  CREATE TABLE IF NOT EXISTS seen_posts (
    post_id TEXT PRIMARY KEY,
    seen_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 내 정보 캐시
  CREATE TABLE IF NOT EXISTS my_info (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 인덱스
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_posts_submadang ON posts(submadang);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_post ON my_interactions(post_id);
`);

// Prepared statements
const stmts = {
  // Posts
  upsertPost: db.prepare(`
    INSERT OR REPLACE INTO posts (id, title, content, author_id, author_name, submadang, upvotes, downvotes, comment_count, created_at, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `),
  getPost: db.prepare(`SELECT * FROM posts WHERE id = ?`),

  // Comments
  upsertComment: db.prepare(`
    INSERT OR REPLACE INTO comments (id, post_id, content, author_id, author_name, created_at, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `),
  getCommentsByPost: db.prepare(`SELECT * FROM comments WHERE post_id = ?`),

  // My interactions
  recordInteraction: db.prepare(`
    INSERT OR REPLACE INTO my_interactions (post_id, action_type, content, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `),
  getInteraction: db.prepare(`SELECT * FROM my_interactions WHERE post_id = ? AND action_type = ?`),
  getAllInteractions: db.prepare(`SELECT * FROM my_interactions ORDER BY created_at DESC`),
  getInteractionsByType: db.prepare(`SELECT * FROM my_interactions WHERE action_type = ? ORDER BY created_at DESC`),

  // Seen posts
  markSeen: db.prepare(`INSERT OR REPLACE INTO seen_posts (post_id, seen_at) VALUES (?, CURRENT_TIMESTAMP)`),
  isSeen: db.prepare(`SELECT 1 FROM seen_posts WHERE post_id = ?`),
  getUnseenCount: db.prepare(`
    SELECT COUNT(*) as count FROM posts p
    WHERE NOT EXISTS (SELECT 1 FROM seen_posts s WHERE s.post_id = p.id)
  `),

  // My info
  setMyInfo: db.prepare(`INSERT OR REPLACE INTO my_info (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`),
  getMyInfo: db.prepare(`SELECT value FROM my_info WHERE key = ?`),
};

export interface Post {
  id: string;
  title: string;
  content: string;
  author_id: string;
  author_name: string;
  submadang: string;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  created_at: string;
}

export interface Comment {
  id: string;
  post_id: string;
  content: string;
  author_id: string;
  author_name: string;
  created_at: string;
}

export interface Interaction {
  id: number;
  post_id: string;
  action_type: "comment" | "upvote" | "downvote";
  content?: string;
  created_at: string;
}

// 캐시 함수들
export const cache = {
  // Posts
  savePost(post: Post): void {
    stmts.upsertPost.run(
      post.id,
      post.title,
      post.content,
      post.author_id,
      post.author_name,
      post.submadang,
      post.upvotes,
      post.downvotes,
      post.comment_count,
      post.created_at
    );
  },

  savePosts(posts: Post[]): void {
    const transaction = db.transaction((posts: Post[]) => {
      for (const post of posts) {
        this.savePost(post);
      }
    });
    transaction(posts);
  },

  getPost(postId: string): Post | undefined {
    return stmts.getPost.get(postId) as Post | undefined;
  },

  // Comments
  saveComment(comment: Comment): void {
    stmts.upsertComment.run(
      comment.id,
      comment.post_id,
      comment.content,
      comment.author_id,
      comment.author_name,
      comment.created_at
    );
  },

  saveComments(comments: Comment[]): void {
    const transaction = db.transaction((comments: Comment[]) => {
      for (const comment of comments) {
        this.saveComment(comment);
      }
    });
    transaction(comments);
  },

  getCommentsByPost(postId: string): Comment[] {
    return stmts.getCommentsByPost.all(postId) as Comment[];
  },

  // My interactions
  recordInteraction(postId: string, actionType: "comment" | "upvote" | "downvote", content?: string): void {
    stmts.recordInteraction.run(postId, actionType, content || null);
  },

  hasInteraction(postId: string, actionType: "comment" | "upvote" | "downvote"): boolean {
    return !!stmts.getInteraction.get(postId, actionType);
  },

  haveICommented(postId: string): boolean {
    return this.hasInteraction(postId, "comment");
  },

  haveIUpvoted(postId: string): boolean {
    return this.hasInteraction(postId, "upvote");
  },

  getAllInteractions(): Interaction[] {
    return stmts.getAllInteractions.all() as Interaction[];
  },

  getInteractionsByType(actionType: "comment" | "upvote" | "downvote"): Interaction[] {
    return stmts.getInteractionsByType.all(actionType) as Interaction[];
  },

  // Seen posts
  markAsSeen(postId: string): void {
    stmts.markSeen.run(postId);
  },

  markManyAsSeen(postIds: string[]): void {
    const transaction = db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmts.markSeen.run(id);
      }
    });
    transaction(postIds);
  },

  isSeen(postId: string): boolean {
    return !!stmts.isSeen.get(postId);
  },

  // My info
  setMyId(agentId: string): void {
    stmts.setMyInfo.run("agent_id", agentId);
  },

  getMyId(): string | undefined {
    const result = stmts.getMyInfo.get("agent_id") as { value: string } | undefined;
    return result?.value;
  },

  setMyName(name: string): void {
    stmts.setMyInfo.run("agent_name", name);
  },

  getMyName(): string | undefined {
    const result = stmts.getMyInfo.get("agent_name") as { value: string } | undefined;
    return result?.value;
  },

  // Stats
  getStats(): {
    totalPosts: number;
    totalComments: number;
    myComments: number;
    myUpvotes: number;
    seenPosts: number;
  } {
    const totalPosts = (db.prepare("SELECT COUNT(*) as count FROM posts").get() as { count: number }).count;
    const totalComments = (db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number }).count;
    const myComments = (db.prepare("SELECT COUNT(*) as count FROM my_interactions WHERE action_type = 'comment'").get() as { count: number }).count;
    const myUpvotes = (db.prepare("SELECT COUNT(*) as count FROM my_interactions WHERE action_type = 'upvote'").get() as { count: number }).count;
    const seenPosts = (db.prepare("SELECT COUNT(*) as count FROM seen_posts").get() as { count: number }).count;

    return { totalPosts, totalComments, myComments, myUpvotes, seenPosts };
  },

  // 캐시된 글 중 내가 댓글 안 단 글 조회
  getUncommentedPosts(): Post[] {
    return db.prepare(`
      SELECT p.* FROM posts p
      WHERE NOT EXISTS (
        SELECT 1 FROM my_interactions i
        WHERE i.post_id = p.id AND i.action_type = 'comment'
      )
      ORDER BY p.created_at DESC
    `).all() as Post[];
  },

  // 캐시된 글 중 내가 안 읽은 글 조회
  getUnseenPosts(): Post[] {
    return db.prepare(`
      SELECT p.* FROM posts p
      WHERE NOT EXISTS (
        SELECT 1 FROM seen_posts s WHERE s.post_id = p.id
      )
      ORDER BY p.created_at DESC
    `).all() as Post[];
  },
};

export default cache;
