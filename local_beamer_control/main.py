"""StreamController-Plugin zur Steuerung eines Acer-Beamers."""

# StreamController-Module
from src.backend.PluginManager.ActionHolder import ActionHolder
from src.backend.PluginManager.PluginBase import PluginBase

from .actions.BeamerPower.BeamerPower import BeamerPower


class BeamerPlugin(PluginBase):
    def __init__(self):
        super().__init__()

        self.beamer_power_holder = ActionHolder(
            plugin_base=self,
            action_base=BeamerPower,
            action_id="local_beamer_control::BeamerPower",
            action_name="Beamer Power",
        )
        self.add_action_holder(self.beamer_power_holder)

        self.register(
            plugin_name="Beamer",
            github_repo="https://github.com/",
            plugin_version="1.0.0",
            app_version="1.5.0-beta.7",
        )
