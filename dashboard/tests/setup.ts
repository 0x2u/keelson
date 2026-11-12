// Every test file runs with a throwaway master key and operator password.
import { hashPassword } from "../lib/password.ts";

process.env.KEELSON_DASHBOARD_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
process.env.KEELSON_ADMIN_PASSWORD_HASH = hashPassword("operator-password-1");
