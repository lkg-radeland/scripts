import streamDeck from "@elgato/streamdeck";

import { BeamerPowerAction } from "./actions/beamer-power";

streamDeck.actions.registerAction(new BeamerPowerAction());

streamDeck.connect();
