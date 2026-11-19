import { z } from "zod";

/** Player names: 1–16 letters, numbers, spaces and _ . ' - (shared by sign-in, rename and admin rename). */
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(16, "Names are 16 characters max.")
  .regex(/^[\p{L}\p{N} _.'-]+$/u, "Letters, numbers, spaces and _ . ' - only.");
