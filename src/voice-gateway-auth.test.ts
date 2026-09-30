import {describe,it,expect} from "vitest";
import {voiceGatewayBootstrap} from "./voice-gateway-auth.js";
describe("voice Gateway bootstrap",()=>{
 it("uses local Gateway credential, not provider keys",()=>{
  expect(voiceGatewayBootstrap("ws://127.0.0.1:18789",{mode:"token",token:"test-gateway"},false,{OPENAI_API_KEY:"not-gateway"})).toEqual({token:"test-gateway",preferBootstrapToken:true});
 });
 it("uses device auth after pairing",()=>{
  expect(voiceGatewayBootstrap("ws://127.0.0.1:18789",{mode:"token",token:"test-gateway"},true,{})).toEqual({});
 });
 it("never forwards Gateway credentials to a remote endpoint",()=>{
  expect(()=>voiceGatewayBootstrap("wss://external.example",{mode:"token",token:"test"},false,{})).toThrow("requires_loopback");
 });
 it("fails closed without a Gateway credential",()=>{
  expect(()=>voiceGatewayBootstrap("ws://127.0.0.1:18789",{mode:"token"},false,{})).toThrow("unavailable");
 });
});
