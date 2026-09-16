# kotlinx.serialization — keep serializers for the :core models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class app.mixbase.core.** {
    *** Companion;
}
-keepclasseswithmembers class app.mixbase.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class app.mixbase.core.**$$serializer { *; }
# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
