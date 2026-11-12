import {
  compact,
  durationError,
  integerError,
  NAME_HINT,
  NAME_PATTERN,
  optionalText,
  toInteger,
} from "@/components/config/FormParts";
import { timezoneError } from "@/components/config/ScheduleFields";
import type { BackupDestinationConfig, DatabaseConfig } from "@/lib/agent-types";
import { scheduleError } from "@/lib/cron-describe";

export type SslMode = NonNullable<DatabaseConfig["ssl_mode"]>;
export type DestinationKind = "local" | "s3";

/** The form's state: every field as text, parsed and trimmed when the configuration is built. */
export interface DatabaseDraft {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  passwordFile: string;
  sslMode: SslMode;
  version: string;
  network: string;
  backup: boolean;
  schedule: string;
  timezone: string;
  recipients: string[];
  keep: string;
  keepDays: string;
  keepPreDeploy: string;
  timeout: string;
  alertAfter: string;
  paused: boolean;
  destination: DestinationKind;
  /**
   * The several destinations a database has when its file lists them (`destinations:`): the form does not edit them, it shows
   * them and sends them back as they are. Null for the usual single destination.
   */
  destinations: BackupDestinationConfig[] | null;
  localDir: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretKeyFile: string;
}

/** An age X25519 public key: "age1" and 58 characters of bech32. */
const AGE_RECIPIENT = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function draftFromDatabase(db: DatabaseConfig | undefined): DatabaseDraft {
  const backup = db?.backups;
  const places = backup?.destinations ?? [];
  // One place is edited with the fields below; several are kept as they are and edited in the raw editor.
  const single = places.length === 1 ? places[0] : undefined;
  const s3 = single?.s3;
  return {
    name: db?.name ?? "",
    host: db?.host ?? "",
    port: db ? (db.port === undefined ? "" : String(db.port)) : "5432",
    database: db?.database ?? "",
    user: db?.user ?? "",
    passwordFile: db?.password_file ?? "",
    sslMode: db?.ssl_mode ?? "",
    version: db?.version ? String(db.version) : "",
    network: db?.network ?? "",
    // A new database starts with a daily backup form to fill in: backing up is what this feature is for.
    backup: db ? backup !== undefined : true,
    schedule: backup?.schedule ?? "0 3 * * *",
    timezone: backup ? (backup.timezone ?? "") : "UTC",
    recipients: backup?.recipients.length ? backup.recipients : [""],
    keep: backup?.keep === undefined ? "" : String(backup.keep),
    keepDays: backup?.keep_days ? String(backup.keep_days) : "",
    keepPreDeploy: backup?.keep_pre_deploy === undefined ? "" : String(backup.keep_pre_deploy),
    timeout: backup?.timeout ?? "",
    alertAfter: backup?.alert_after === undefined ? "" : String(backup.alert_after),
    paused: backup?.paused ?? false,
    destination: s3 ? "s3" : "local",
    destinations: places.length > 1 ? places : null,
    localDir: single?.local?.dir ?? "",
    s3Endpoint: s3?.endpoint ?? "",
    s3Region: s3?.region ?? "",
    s3Bucket: s3?.bucket ?? "",
    s3Prefix: s3?.prefix ?? "",
    s3AccessKeyId: s3?.access_key_id ?? "",
    s3SecretKeyFile: s3?.secret_key_file ?? "",
  };
}

/** The configuration to send: only the chosen destination's fields, and no empty optional fields. */
export function databaseFromDraft(d: DatabaseDraft): DatabaseConfig {
  const db: DatabaseConfig = { name: d.name.trim(), host: d.host.trim(), database: d.database.trim(), user: d.user.trim() };
  const port = toInteger(d.port);
  if (port !== undefined) db.port = port;
  const passwordFile = optionalText(d.passwordFile);
  if (passwordFile) db.password_file = passwordFile;
  if (d.sslMode !== "") db.ssl_mode = d.sslMode;
  const version = toInteger(d.version);
  if (version !== undefined) db.version = version;
  const network = optionalText(d.network);
  if (network) db.network = network;
  if (!d.backup) return db;

  const backup: NonNullable<DatabaseConfig["backups"]> = {
    schedule: d.schedule.trim(),
    recipients: compact(d.recipients),
    destinations: [],
  };
  if (d.destinations) {
    backup.destinations = d.destinations;
  } else if (d.destination === "local") {
    backup.destinations = [{ local: { dir: d.localDir.trim() } }];
  } else {
    const prefix = optionalText(d.s3Prefix);
    backup.destinations = [
      {
        s3: {
          endpoint: d.s3Endpoint.trim(),
          region: d.s3Region.trim(),
          bucket: d.s3Bucket.trim(),
          ...(prefix === undefined ? {} : { prefix }),
          access_key_id: d.s3AccessKeyId.trim(),
          secret_key_file: d.s3SecretKeyFile.trim(),
        },
      },
    ];
  }
  const timezone = optionalText(d.timezone);
  if (timezone) backup.timezone = timezone;
  const keep = toInteger(d.keep);
  if (keep !== undefined) backup.keep = keep;
  const keepDays = toInteger(d.keepDays);
  if (keepDays !== undefined) backup.keep_days = keepDays;
  const keepPreDeploy = toInteger(d.keepPreDeploy);
  if (keepPreDeploy !== undefined) backup.keep_pre_deploy = keepPreDeploy;
  const timeout = optionalText(d.timeout);
  if (timeout) backup.timeout = timeout;
  const alertAfter = toInteger(d.alertAfter);
  if (alertAfter !== undefined) backup.alert_after = alertAfter;
  if (d.paused) backup.paused = true;
  db.backups = backup;
  return db;
}

function absolutePathError(path: string, what: string): string | undefined {
  const text = path.trim();
  if (text === "") return `Enter ${what}.`;
  return text.startsWith("/") ? undefined : "Use an absolute path, starting with /.";
}

function endpointError(endpoint: string): string | undefined {
  const text = endpoint.trim();
  if (text === "") return "Enter the endpoint URL.";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "That is not a valid URL. Include the scheme, for example https://s3.eu-west-1.amazonaws.com.";
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return undefined;
  return "Use https://. Plain http:// is accepted only for localhost, such as a MinIO on the same host.";
}

function requiredError(value: string, what: string): string | undefined {
  return value.trim() === "" ? `Enter ${what}.` : undefined;
}

/** What is wrong with the form, field by field; empty when it can be sent. Keys name the fields. */
export function validateDatabase(d: DatabaseDraft, creating: boolean, existingNames: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const check = (field: string, message: string | undefined) => {
    if (message) errors[field] = message;
  };

  if (creating) {
    const name = d.name.trim();
    if (name === "") errors.name = "Enter a name.";
    else if (!NAME_PATTERN.test(name)) errors.name = `"${name}" is not a valid name. ${NAME_HINT}`;
    else if (existingNames.includes(name)) errors.name = `A database named ${name} already exists.`;
  }
  check("host", requiredError(d.host, "the host or address of the database server"));
  check("port", integerError(d.port, "The port", 1, 65535));
  check("database", requiredError(d.database, "the PostgreSQL database name"));
  check("user", requiredError(d.user, "the user to connect as"));
  if (d.passwordFile.trim() !== "") check("password_file", absolutePathError(d.passwordFile, "the path"));
  check("version", integerError(d.version, "The version", 10, 99));

  if (!d.backup) return errors;

  check("schedule", scheduleError(d.schedule) ?? undefined);
  if (d.timezone.trim() !== "") check("timezone", timezoneError(d.timezone.trim()));
  const keys = compact(d.recipients);
  if (keys.length === 0) errors.recipients = "Add at least one age public key: backups are encrypted to it.";
  else if (keys.some((k) => !AGE_RECIPIENT.test(k))) errors.recipients = "Every recipient is an age public key: age1 followed by 58 characters.";
  check("keep", integerError(d.keep, "The number of backups to keep", 1, 100000));
  check("keep_days", integerError(d.keepDays, "The number of days", 0, 100000));
  check("keep_pre_deploy", integerError(d.keepPreDeploy, "The number of backups", 1, 100000));
  check("timeout", durationError(d.timeout));
  check("alert_after", integerError(d.alertAfter, "The failure count", 1, 1000));

  if (d.destinations) {
    // Edited in the raw editor: the agent validates them.
  } else if (d.destination === "local") {
    check("local_dir", absolutePathError(d.localDir, "the directory"));
  } else {
    check("s3_endpoint", endpointError(d.s3Endpoint));
    check("s3_region", requiredError(d.s3Region, "the region"));
    check("s3_bucket", requiredError(d.s3Bucket, "the bucket"));
    if (d.s3Prefix.trim().startsWith("/") || d.s3Prefix.trim().endsWith("/")) errors.s3_prefix = "No leading or trailing slash.";
    check("s3_access_key_id", requiredError(d.s3AccessKeyId, "the access key ID"));
    check("s3_secret_key_file", absolutePathError(d.s3SecretKeyFile, "the path of the file that holds the secret key"));
  }
  return errors;
}

/** The value of the Project choice that means "no project". */
export const NO_PROJECT = "none";

/** The project choices of the form: none, then the known projects (and the database's own when it is not among them), sorted. */
export function projectOptions(projects: string[], current: string): { value: string; label: string }[] {
  const names = [...new Set([...projects, ...(current === "" ? [] : [current])])].sort((a, b) => a.localeCompare(b));
  return [{ value: NO_PROJECT, label: "No project" }, ...names.map((name) => ({ value: name, label: name }))];
}
