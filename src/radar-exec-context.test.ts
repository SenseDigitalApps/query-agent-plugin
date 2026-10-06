import { describe, it, expect } from "vitest";
import { radarExecContext, RADAR_EXEC_ENV } from "./radar-exec-context.js";
const key = "agent:comunicaciones:query:group:129";
describe("radar runtime identity", () => {
  it("attributes the exact gateway Query scope", () => {
    const result = radarExecContext({host:"gateway",sessionKey:key},{agentId:"comunicaciones",sessionKey:key,messageProvider:"query"});
    expect(JSON.parse(result[RADAR_EXEC_ENV])).toMatchObject({agentId:"comunicaciones",channelId:"129"});
  });
  it.each([
    [{host:"node",sessionKey:key},{agentId:"comunicaciones",sessionKey:key}],
    [{host:"gateway",sessionKey:key},{agentId:"main",sessionKey:key}],
    [{host:"gateway",sessionKey:key},{agentId:"comunicaciones",sessionKey:key,messageProvider:"telegram"}],
    [{host:"gateway",sessionKey:key},{agentId:"comunicaciones",sessionKey:"agent:comunicaciones:query:group:134"}],
    [{host:"gateway",sessionKey:"agent:comunicaciones:query:direct:129"},{agentId:"comunicaciones"}],
    [{host:"gateway"},{}],
  ])("clears identity outside exact attributed scope", (event,ctx) => {
    expect(radarExecContext(event,ctx)).toEqual({[RADAR_EXEC_ENV]:""});
  });
});
