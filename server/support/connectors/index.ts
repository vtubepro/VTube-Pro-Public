// Every support connector, by service id (server/support/types.ts SupportConnector).
import type { SupportService } from '../../../shared/supportConfig.ts';
import type { SupportConnector } from '../types.ts';
import { BmcConnector } from './bmc.ts';
import { FourthwallConnector } from './fourthwall.ts';
import { KofiConnector } from './kofi.ts';
import { PatreonConnector } from './patreon.ts';
import { StreamElementsConnector } from './streamelements.ts';
import { StreamlabsConnector } from './streamlabs.ts';
import { StripeConnector } from './stripe.ts';
import { ThroneConnector } from './throne.ts';

export function makeConnector(id: SupportService): SupportConnector | null {
  switch (id) {
    case 'fourthwall': return new FourthwallConnector();
    case 'throne': return new ThroneConnector();
    case 'stripe': return new StripeConnector();
    case 'bmc': return new BmcConnector();
    case 'patreon': return new PatreonConnector();
    case 'kofi': return new KofiConnector();
    case 'streamelements': return new StreamElementsConnector();
    case 'streamlabs': return new StreamlabsConnector();
    default: return null;
  }
}
