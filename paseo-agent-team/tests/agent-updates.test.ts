import { describe, expect, test, vi } from "vitest";
import { type AgentUpdatesPort, subscribeToAgentUpdates } from "../shared/paseo/agent-updates";

type Observer = {
  snapshot(snapshot: unknown): void;
  update(message: unknown): void;
  error?(error: unknown): void;
};

/** Behaves like the host's owned subscription: it replays its snapshot to a new observer. */
function fakeSubscription() {
  const observers = new Set<Observer>();
  return {
    observers,
    release: vi.fn(async () => undefined),
    subscribe: vi.fn((observer: Observer) => {
      observers.add(observer);
      observer.snapshot({});
      return () => {
        observers.delete(observer);
      };
    }),
    emit() {
      for (const observer of observers) observer.update({ type: "agent_update" });
    },
    reconnect() {
      for (const observer of observers) observer.snapshot({});
    },
  };
}

type FakeSubscription = ReturnType<typeof fakeSubscription>;

function portWith(...subscriptions: FakeSubscription[]) {
  const queue = [...subscriptions];
  const list = vi.fn(async (_options: Parameters<AgentUpdatesPort["agents"]["list"]>[0]) => {
    const subscription = queue.shift();
    if (!subscription) throw new Error("no subscription left");
    return { subscription };
  });
  return { list, port: { agents: { list } } satisfies AgentUpdatesPort };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("subscribeToAgentUpdates", () => {
  test("asks the host to stream every agent and reports each update", async () => {
    const subscription = fakeSubscription();
    const { port, list } = portWith(subscription);
    const onChange = vi.fn();
    subscribeToAgentUpdates(port, onChange);
    await settle();

    expect(list).toHaveBeenCalledWith({ page: { limit: 1 }, subscribe: {} });
    expect(onChange).not.toHaveBeenCalled(); // the replayed snapshot is not a change

    subscription.emit();
    subscription.emit();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("a snapshot after the first means the connection was restored", async () => {
    const subscription = fakeSubscription();
    const onChange = vi.fn();
    subscribeToAgentUpdates(portWith(subscription).port, onChange);
    await settle();

    subscription.reconnect();
    expect(onChange).toHaveBeenCalledOnce();
  });

  test("each filter gets its own subscription", async () => {
    const coordinators = fakeSubscription();
    const members = fakeSubscription();
    const { port, list } = portWith(coordinators, members);
    const onChange = vi.fn();
    const stop = subscribeToAgentUpdates(port, onChange, [
      { labels: { "agent-team.kind": "coordinator" } },
      { labels: { "agent-team.kind": "member" } },
    ]);
    await settle();

    expect(list.mock.calls.map(([options]) => options.filter)).toEqual([
      { labels: { "agent-team.kind": "coordinator" } },
      { labels: { "agent-team.kind": "member" } },
    ]);
    coordinators.emit();
    members.emit();
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    expect(coordinators.release).toHaveBeenCalledOnce();
    expect(members.release).toHaveBeenCalledOnce();
  });

  test("a filter without labels is sent as no filter at all", async () => {
    const { port, list } = portWith(fakeSubscription());
    subscribeToAgentUpdates(port, vi.fn(), [{}]);
    await settle();
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty("filter");
  });

  test("cleanup detaches the observer and releases the subscription", async () => {
    const subscription = fakeSubscription();
    const onChange = vi.fn();
    const stop = subscribeToAgentUpdates(portWith(subscription).port, onChange);
    await settle();

    stop();
    subscription.emit();
    expect(subscription.observers.size).toBe(0);
    expect(subscription.release).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("cleaning up before the host answers releases the subscription without attaching", async () => {
    const subscription = fakeSubscription();
    let answer: (value: { subscription: FakeSubscription }) => void = () => undefined;
    const port = {
      agents: {
        list: vi.fn(
          () =>
            new Promise<{ subscription: FakeSubscription }>((resolve) => {
              answer = resolve;
            }),
        ),
      },
    } satisfies AgentUpdatesPort;
    const onChange = vi.fn();

    const stop = subscribeToAgentUpdates(port, onChange);
    stop();
    answer({ subscription });
    await settle();

    expect(subscription.subscribe).not.toHaveBeenCalled();
    expect(subscription.release).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a subscription the host refuses is not an error for the caller", async () => {
    const port = {
      agents: {
        list: vi.fn(async () => {
          throw new Error("daemon too old");
        }),
      },
    } satisfies AgentUpdatesPort;
    const stop = subscribeToAgentUpdates(port, vi.fn());
    await settle();
    expect(() => stop()).not.toThrow();
  });

  test("a subscription that ended before it could be attached is released", async () => {
    const subscription = fakeSubscription();
    subscription.subscribe.mockImplementation(() => {
      throw new Error("Subscription released");
    });
    subscribeToAgentUpdates(portWith(subscription).port, vi.fn());
    await settle();
    expect(subscription.release).toHaveBeenCalledOnce();
  });

  test("a failing release is swallowed", async () => {
    const subscription = fakeSubscription();
    subscription.release.mockRejectedValue(new Error("connection closed"));
    const stop = subscribeToAgentUpdates(portWith(subscription).port, vi.fn());
    await settle();
    expect(() => stop()).not.toThrow();
    await settle();
  });
});
