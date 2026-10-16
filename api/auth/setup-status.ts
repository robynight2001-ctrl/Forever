import { handleCors, sendJson } from '../_utils';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;
  return sendJson(res, 200, { success: true, isConfigured: true });
}
