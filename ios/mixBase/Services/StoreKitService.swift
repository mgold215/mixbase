// ios/mixBase/Services/StoreKitService.swift
// Manages StoreKit 2 in-app purchases for Pro and Studio subscriptions.
// After a successful purchase, sends the transaction to the server for verification
// and calls AuthService to update the local subscription tier.

import StoreKit
import Foundation

@MainActor
class StoreKitService: ObservableObject {

    static let shared = StoreKitService()

    let productIds = [
        "com.moodmixformat.mixbase.pro.monthly",
        "com.moodmixformat.mixbase.studio.monthly",
    ]

    @Published var products: [Product] = []
    @Published var isPurchasing = false
    @Published var purchaseError: String? = nil

    private var transactionListener: Task<Void, Never>?

    private init() {
        transactionListener = Task { await listenForTransactions() }
        Task { await loadProducts() }
    }

    deinit {
        transactionListener?.cancel()
    }

    // MARK: - Load products from App Store
    func loadProducts() async {
        do {
            let storeProducts = try await Product.products(for: productIds)
            // Sort: Pro first, Studio second
            products = storeProducts.sorted { a, b in
                (productIds.firstIndex(of: a.id) ?? 0) < (productIds.firstIndex(of: b.id) ?? 0)
            }
        } catch {
            print("[StoreKit] Failed to load products: \(error)")
        }
    }

    // MARK: - Purchase a product
    func purchase(_ product: Product) async {
        isPurchasing = true
        purchaseError = nil

        do {
            let result = try await product.purchase()

            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await verifyWithServer(transaction: transaction)
                    await transaction.finish()
                case .unverified:
                    purchaseError = "Purchase verification failed"
                }
            case .userCancelled:
                break
            case .pending:
                purchaseError = "Purchase is pending approval"
            @unknown default:
                break
            }
        } catch {
            purchaseError = "Purchase failed: \(error.localizedDescription)"
        }

        isPurchasing = false
    }

    // MARK: - Send transaction to server for verification + tier update
    private func verifyWithServer(transaction: Transaction) async {
        guard let token = KeychainService.load(forKey: "access_token"),
              let url = URL(string: "https://mixbase.app/api/iap/apple/verify") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("sb-access-token=\(token)", forHTTPHeaderField: "Cookie")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "transactionId": String(transaction.id),
            "productId": transaction.productID,
        ])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                print("[StoreKit] Server verification failed")
                return
            }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let tier = json?["tier"] as? String ?? "free"
            AuthService.shared.subscriptionTier = tier
        } catch {
            print("[StoreKit] Network error during verification: \(error)")
        }
    }

    // MARK: - Listen for transactions (handles renewals, refunds, etc.)
    private func listenForTransactions() async {
        for await result in Transaction.updates {
            switch result {
            case .verified(let transaction):
                await verifyWithServer(transaction: transaction)
                await transaction.finish()
            case .unverified:
                break
            }
        }
    }

    // MARK: - Restore purchases
    func restorePurchases() async {
        isPurchasing = true
        do {
            try await AppStore.sync()
            await AuthService.shared.fetchSubscription()
        } catch {
            purchaseError = "Restore failed: \(error.localizedDescription)"
        }
        isPurchasing = false
    }
}
