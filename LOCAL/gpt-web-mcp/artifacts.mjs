import { z } from 'zod'

// A sandbox reference is a ChatGPT artifact handle, never a local filesystem path
// or an arbitrary URL to fetch. The extension activates only its matching DOM link.
export const artifactPath = z.string().max(1200).regex(/^sandbox:\/mnt\/data\/[^\u0000-\u001f?#]+$/)
export const artifactList = z.array(z.object({
  path: artifactPath,
  name: z.string().min(1).max(200),
  messageId: z.string().min(1).max(220)
}).strict()).max(32)
