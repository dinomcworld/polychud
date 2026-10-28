/**
 * Minimal stand-ins for discord.js interactions. They implement only what the
 * bot's handlers touch, and record every response so tests can assert on what
 * a user would have seen. Builders (embeds, rows, modals) are serialized with
 * their own `toJSON()`, so assertions run against the exact API payload.
 */
import type {
  APIEmbed,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";

export type ResponseMethod =
  | "reply"
  | "deferReply"
  | "deferUpdate"
  | "editReply"
  | "followUp"
  | "update"
  | "showModal";

export interface Response {
  method: ResponseMethod;
  /** JSON-serialized payload (builders already converted). */
  payload: Payload;
}

export interface Payload {
  content?: string;
  embeds?: APIEmbed[];
  components?: Array<{ components?: Array<Record<string, unknown>> }>;
  files?: unknown[];
  flags?: number;
  custom_id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface FakeUser {
  id: string;
  username: string;
  displayName: string;
  tag: string;
  bot: boolean;
  displayAvatarURL: () => string;
}

export function fakeUser(id: string, username = `user${id}`): FakeUser {
  return {
    id,
    username,
    displayName: username,
    tag: username,
    bot: false,
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
  };
}

export const GUILD_ID = "guild-e2e";

function toJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJSON);
  if (value && typeof value === "object") {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return value.toJSON();
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJSON(v)]),
    );
  }
  return value;
}

function serialize(payload: unknown): Payload {
  if (typeof payload === "string") return { content: payload };
  return (toJSON(payload) ?? {}) as Payload;
}

class Recorder {
  readonly responses: Response[] = [];
  deferred = false;
  replied = false;

  protected record(method: ResponseMethod, payload: unknown) {
    this.responses.push({ method, payload: serialize(payload) });
    return Promise.resolve({ id: `msg-${this.responses.length}` });
  }

  /** The latest response of the given kinds (default: anything visible). */
  last(...methods: ResponseMethod[]): Payload {
    const wanted = methods.length
      ? methods
      : (["reply", "editReply", "followUp", "update"] as ResponseMethod[]);
    const found = [...this.responses]
      .reverse()
      .find((r) => wanted.includes(r.method));
    if (!found) {
      throw new Error(
        `No ${wanted.join("/")} response. Got: ${this.responses.map((r) => r.method).join(", ") || "nothing"}`,
      );
    }
    return found.payload;
  }
}

abstract class BaseInteraction extends Recorder {
  readonly guildId: string | null;
  readonly guild: { id: string; name: string } | null;
  readonly channelId = "channel-e2e";
  readonly channel = null;
  readonly client = {
    users: { fetch: async (id: string) => fakeUser(id) },
  };

  constructor(
    readonly user: FakeUser,
    guildId: string | null = GUILD_ID,
  ) {
    super();
    this.guildId = guildId;
    this.guild = guildId ? { id: guildId, name: "E2E Guild" } : null;
  }

  isRepliable() {
    return true;
  }

  reply(payload: unknown) {
    this.replied = true;
    return this.record("reply", payload);
  }

  deferReply(payload?: unknown) {
    this.deferred = true;
    return this.record("deferReply", payload ?? {});
  }

  editReply(payload: unknown) {
    return this.record("editReply", payload);
  }

  followUp(payload: unknown) {
    return this.record("followUp", payload);
  }
}

class ComponentInteraction extends BaseInteraction {
  readonly message = { id: "message-e2e" };

  constructor(
    user: FakeUser,
    readonly customId: string,
    guildId?: string | null,
  ) {
    super(user, guildId);
  }

  deferUpdate() {
    this.deferred = true;
    return this.record("deferUpdate", {});
  }

  update(payload: unknown) {
    this.replied = true;
    return this.record("update", payload);
  }

  showModal(modal: unknown) {
    this.replied = true;
    return this.record("showModal", modal);
  }
}

export class FakeButton extends ComponentInteraction {
  as() {
    return this as unknown as ButtonInteraction;
  }
}

export class FakeSelect extends ComponentInteraction {
  constructor(
    user: FakeUser,
    customId: string,
    readonly values: string[],
    guildId?: string | null,
  ) {
    super(user, customId, guildId);
  }

  as() {
    return this as unknown as StringSelectMenuInteraction;
  }
}

export class FakeModalSubmit extends BaseInteraction {
  readonly fields: { getTextInputValue: (id: string) => string };

  constructor(
    user: FakeUser,
    readonly customId: string,
    inputs: Record<string, string>,
    guildId?: string | null,
  ) {
    super(user, guildId);
    this.fields = {
      getTextInputValue: (id: string) => {
        const value = inputs[id];
        if (value === undefined) throw new Error(`No modal input "${id}"`);
        return value;
      },
    };
  }

  as() {
    return this as unknown as ModalSubmitInteraction;
  }
}

export class FakeCommand extends BaseInteraction {
  readonly options: {
    getSubcommand: (required?: boolean) => string | null;
    getString: (name: string, required?: boolean) => string | null;
    getUser: (name: string) => FakeUser | null;
  };

  constructor(
    user: FakeUser,
    readonly commandName: string,
    opts: {
      subcommand?: string;
      strings?: Record<string, string>;
      users?: Record<string, FakeUser>;
    } = {},
    guildId?: string | null,
  ) {
    super(user, guildId);
    this.options = {
      getSubcommand: () => opts.subcommand ?? null,
      getString: (name, required) => {
        const v = opts.strings?.[name] ?? null;
        if (required && v === null) throw new Error(`Missing option ${name}`);
        return v;
      },
      getUser: (name) => opts.users?.[name] ?? null,
    };
  }

  as() {
    return this as unknown as ChatInputCommandInteraction;
  }
}

/** All custom_ids on a payload's components (buttons and select menus). */
export function customIds(payload: Payload): string[] {
  return (payload.components ?? []).flatMap((row) =>
    (row.components ?? [])
      .map((c) => c.custom_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** The select menu's option values on a payload, if any. */
export function selectValues(payload: Payload): string[] {
  return (payload.components ?? []).flatMap((row) =>
    (row.components ?? []).flatMap((c) =>
      Array.isArray(c.options)
        ? (c.options as Array<{ value: string }>).map((o) => o.value)
        : [],
    ),
  );
}

/** Text of all embeds on a payload, for loose content assertions. */
export function embedText(payload: Payload): string {
  return (payload.embeds ?? [])
    .map((e) =>
      [
        e.title,
        e.description,
        e.footer?.text,
        ...(e.fields ?? []).flatMap((f) => [f.name, f.value]),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}
