import { afterEach, describe, expect, it, vi } from "vitest";
import { digestSha256, encodeText, hmac, randomHex, toHex } from "./crypto";

/**
 * Deterministic crypto-helper tests.
 *
 * The module is backed by WebCrypto (`crypto.subtle`); vectors below were
 * generated with node:crypto and match the public RFC 4231 / FIPS-180-4 test
 * vectors so the suite never depends on runtime randomness.
 */
describe("auth/crypto encodeText", () => {
  it("encodes ASCII text to UTF-8 bytes", () => {
    expect(Array.from(encodeText("abc"))).toEqual([0x61, 0x62, 0x63]);
  });

  it("encodes multi-byte characters as UTF-8", () => {
    expect(Array.from(encodeText("中"))).toEqual([0xe4, 0xb8, 0xad]);
  });

  it("handles empty strings", () => {
    expect(encodeText("").length).toBe(0);
  });
});

describe("auth/crypto toHex", () => {
  it("formats a Uint8Array as lowercase hex", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0x10, 0xff]))).toBe("000f10ff");
  });

  it("accepts an ArrayBuffer input", () => {
    const buffer = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    expect(toHex(buffer)).toBe("deadbeef");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(toHex(new Uint8Array(0))).toBe("");
  });

  it("zero-pads single nibbles", () => {
    expect(toHex(new Uint8Array([0x1, 0xa]))).toBe("010a");
  });
});

describe("auth/crypto hmac", () => {
  it("matches the RFC 4231 HMAC-SHA256 test vector", async () => {
    // RFC 4231 test case 1: 20-byte key 0x0b…, data "Hi There".
    const key = "".padEnd(20, "\u000b");
    await expect(hmac("Hi There", key)).resolves.toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("matches the well-known 'quick brown fox' vector", async () => {
    await expect(hmac("The quick brown fox jumps over the lazy dog", "key")).resolves.toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("is deterministic for the same message and secret", async () => {
    const first = await hmac("session-id-1", "test-secret");
    const second = await hmac("session-id-1", "test-secret");
    expect(first).toBe("37d64e66ad849bd6505cc891d19a77d720884ab257a99543dabbbc661c8224fd");
    expect(second).toBe(first);
  });

  it("produces different signatures for different secrets", async () => {
    const a = await hmac("message", "secret-a");
    const b = await hmac("message", "secret-b");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different messages", async () => {
    const a = await hmac("message-1", "secret");
    const b = await hmac("message-2", "secret");
    expect(a).not.toBe(b);
  });

  it("returns 64 lowercase hex characters (256-bit output)", async () => {
    const sig = await hmac("any message", "any secret");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("auth/crypto digestSha256", () => {
  it("matches the FIPS-180-4 SHA-256 vector for 'abc'", async () => {
    await expect(digestSha256("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the SHA-256 empty-string vector", async () => {
    await expect(digestSha256("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic for the same input", async () => {
    const a = await digestSha256("hermes dashboard");
    const b = await digestSha256("hermes dashboard");
    expect(a).toBe("597404656ec00583c227b90ce8b20280f362c129d0527b10fa9fd34cc62c2398");
    expect(b).toBe(a);
  });

  it("differs across inputs", async () => {
    const a = await digestSha256("hermes dashboard");
    const b = await digestSha256("hermes desktop");
    expect(a).not.toBe(b);
  });
});

describe("auth/crypto randomHex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns twice the requested byte count in hex", () => {
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomHex(1)).toMatch(/^[0-9a-f]{2}$/);
  });

  it("defaults to 16 bytes (32 hex chars)", () => {
    expect(randomHex()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reflects the random source when stubbed", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((arr) => {
        new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).fill(0xab);
        return arr;
      });
    expect(randomHex(4)).toBe("abababab");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("produces distinct values across calls", () => {
    expect(randomHex(8)).not.toBe(randomHex(8));
  });
});
