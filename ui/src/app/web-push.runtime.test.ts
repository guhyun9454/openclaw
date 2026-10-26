/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import {
  getExistingSubscription,
  subscribeToWebPush,
  unsubscribeFromWebPush,
} from "./web-push.runtime.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);

function installServiceWorker(
  ready: Promise<ServiceWorkerRegistration>,
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined> = () => ready,
): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready, getRegistration },
  });
}

const vapidBytes = [4, 1, 2, 3];
function existingSubscription(): PushSubscription {
  return {
    endpoint: "https://push.example.test/subscription",
    options: {
      applicationServerKey: Uint8Array.from(vapidBytes).buffer,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
    }),
  } as unknown as PushSubscription;
}

function gatewayClient() {
  const request = vi.fn(async (method: string) => {
    if (method === "push.web.vapidPublicKey") {
      return { vapidPublicKey: Buffer.from(vapidBytes).toString("base64url") };
    }
    if (method === "push.web.subscribe") {
      return { subscriptionId: "subscription-1" };
    }
    return { removed: true };
  });
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

function grantPermission() {
  vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restorePropertyDescriptor(navigator, "serviceWorker", originalServiceWorkerDescriptor);
});

it.each([false, true])(
  "reads an existing subscription without waiting for activation (registration: %s)",
  async (registered) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const subscription = existingSubscription();
    installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}), async () =>
      registered ? registration(subscription) : undefined,
    );

    const result = expect(getExistingSubscription()).resolves.toBe(
      registered ? subscription : null,
    );
    await Promise.all([result, vi.advanceTimersByTimeAsync(10_000)]);
  },
);

it("treats a registration without PushManager as unsupported instead of throwing", async () => {
  installServiceWorker(Promise.resolve({} as ServiceWorkerRegistration));
  await expect(getExistingSubscription()).resolves.toBeNull();
});

it("still rejects when service worker readiness times out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}));
  grantPermission();

  const subscription = subscribeToWebPush(gatewayClient().client, () => {});
  const rejection = expect(subscription).rejects.toThrow("Service worker not ready (timed out)");
  await vi.advanceTimersByTimeAsync(10_000);

  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

it("unsubscribes locally without waiting for activation when the Gateway no longer owns the subscription row", async () => {
  const subscription = existingSubscription();
  const unsubscribe = vi.fn().mockResolvedValue(true);
  subscription.unsubscribe = unsubscribe;
  installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}), async () =>
    registration(subscription),
  );
  const request = vi.fn().mockRejectedValue(new Error("FORBIDDEN"));

  await expect(
    unsubscribeFromWebPush({ request } as unknown as GatewayBrowserClient),
  ).resolves.toBeUndefined();

  expect(request).toHaveBeenCalledWith("push.web.unsubscribe", {
    endpoint: subscription.endpoint,
  });
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("reuses a matching VAPID subscription and clears each readiness timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const subscription = existingSubscription();
  const subscribe = vi
    .fn()
    .mockRejectedValue(new DOMException("Options differ", "InvalidStateError"));
  installServiceWorker(Promise.resolve(registration(subscription, subscribe)));
  grantPermission();
  const { client, request } = gatewayClient();

  for (let i = 0; i < 3; i += 1) {
    await expect(subscribeToWebPush(client, () => {})).resolves.toEqual({
      state: "registered",
      subscription,
    });
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(request).toHaveBeenNthCalledWith(1, "push.web.vapidPublicKey", {});
  expect(request).toHaveBeenNthCalledWith(2, "push.web.subscribe", {
    endpoint: subscription.endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
  });
  expect(subscribe).not.toHaveBeenCalled();
});

function registration(subscription: PushSubscription, subscribe = vi.fn()) {
  return {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe },
  } as unknown as ServiceWorkerRegistration;
}
