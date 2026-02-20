import { handleGenerateConfig } from "./generate-config.ts";
import { handleGenerateDungeon } from "./generate-dungeon.ts";
import { handleDescribeRooms, handleDescribeRoom } from "./describe-rooms.ts";
import { handleDescribeDungeon } from "./describe-dungeon.ts";

export async function handleApiRoute(req: Request, pathname: string): Promise<Response | null> {
  if (req.method === "POST") {
    if (pathname === "/api/generate-config") return handleGenerateConfig(req);
    if (pathname === "/api/generate-dungeon") return handleGenerateDungeon(req);
    if (pathname === "/api/describe-rooms") return handleDescribeRooms(req);
    if (pathname === "/api/describe-dungeon") return handleDescribeDungeon(req);

    const roomMatch = pathname.match(/^\/api\/describe-room\/(\d+)$/);
    if (roomMatch) return handleDescribeRoom(req, roomMatch[1]!);
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}
