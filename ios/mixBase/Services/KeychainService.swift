import Foundation
import Security

// MARK: - KeychainService
// Simple wrapper around the iOS Keychain for persisting auth tokens securely.
// All values are stored as UTF-8 strings under a unique key.

struct KeychainService {

    // The service name groups all our keychain items together
    private static let service = "com.moodmixformat.mixbase"

    // MARK: - Save
    static func save(_ value: String, forKey key: String) {
        let data = Data(value.utf8)

        // Build the query to find any existing item
        let query: [CFString: Any] = [
            kSecClass:            kSecClassGenericPassword,
            kSecAttrService:      service,
            kSecAttrAccount:      key,
        ]

        // Try to update an existing item first. We also push the accessibility
        // attribute on update so older items get upgraded to AfterFirstUnlock.
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if status == errSecItemNotFound {
            // Item doesn't exist yet — add it.
            // kSecAttrAccessibleAfterFirstUnlock lets us read/refresh the token
            // while the app is backgrounded and the device is locked (e.g. a
            // foreground refresh kicked off just as the screen locks), which
            // kSecAttrAccessibleWhenUnlocked (the default) would block.
            var addQuery = query
            addQuery[kSecValueData] = data
            addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    // MARK: - Load
    static func load(forKey key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass:            kSecClassGenericPassword,
            kSecAttrService:      service,
            kSecAttrAccount:      key,
            kSecReturnData:       true,
            kSecMatchLimit:       kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

    // MARK: - Delete
    static func delete(forKey key: String) {
        let query: [CFString: Any] = [
            kSecClass:       kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Clear all
    static func clearAll() {
        for key in ["access_token", "refresh_token", "user_id", "user_email", "expires_at"] {
            delete(forKey: key)
        }
    }
}
