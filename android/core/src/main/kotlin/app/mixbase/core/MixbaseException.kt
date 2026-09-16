package app.mixbase.core

/** Every error the clients surface. [userMessage] is safe to show verbatim. */
sealed class MixbaseException(val userMessage: String, cause: Throwable? = null) : Exception(userMessage, cause) {

    /** No valid session — the refresh token was rejected. */
    class NotAuthenticated : MixbaseException("Your session expired. Please sign in again.")

    /** The server answered with its own human-readable error. */
    class Server(val status: Int, message: String) : MixbaseException(message)

    /** Non-2xx with no usable error body. */
    class Http(val status: Int) : MixbaseException("Request failed (HTTP $status)")

    /** The response didn't have the shape we expected. */
    class InvalidResponse(message: String) : MixbaseException(message)

    /** Couldn't reach the server at all. */
    class Network(cause: Throwable) : MixbaseException("Network error. Check your connection.", cause)

    /** Something wasn't there. */
    class NotFound(message: String) : MixbaseException(message)
}

/** Human-readable text for any throwable that reaches the UI. */
val Throwable.displayMessage: String
    get() = when (this) {
        is MixbaseException -> userMessage
        is java.io.IOException -> "Network error. Check your connection."
        else -> message ?: "Something went wrong"
    }
