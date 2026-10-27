import { createPlatformCommandMac, type PlatformCommandMacHeaders } from "./platform-command-mac.ts";

/**
 * X worker command MAC. The wire format is defined by `platformId`; the display
 * name only appears in error text. X validates the caller context eagerly, so
 * it keeps `contextCheck: "eager"` to preserve its error ordering.
 */
const mac = createPlatformCommandMac({ platformId: "x", displayName: "X", contextCheck: "eager" });

export const X_COMMAND_MAC_CONTEXT = mac.context;
export const readXCommandKeyFile = mac.readCommandKeyFile;
export const XCommandMacSigner = mac.Signer;
export const XCommandMacVerifier = mac.Verifier;

export type XCommandMacHeaders = PlatformCommandMacHeaders;
export type XCommandMacSigner = InstanceType<typeof mac.Signer>;
export type XCommandMacVerifier = InstanceType<typeof mac.Verifier>;
