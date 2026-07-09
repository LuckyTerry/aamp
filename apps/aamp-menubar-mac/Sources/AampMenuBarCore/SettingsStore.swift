import Foundation

public final class SettingsStore {
    private enum Key {
        static let settings = "launcherSettings"
    }

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> LauncherSettings {
        guard let data = defaults.data(forKey: Key.settings),
              let settings = try? decoder.decode(LauncherSettings.self, from: data)
        else {
            return .defaults
        }
        return settings
    }

    public func save(_ settings: LauncherSettings) {
        let data = try? encoder.encode(settings)
        defaults.set(data, forKey: Key.settings)
    }
}
