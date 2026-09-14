import {
    startTransition,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
} from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { AnimatePresence, motion } from "framer-motion"

interface ResponsiveImageValue {
    src?: string
    srcSet?: string
    alt?: string
    url?: string
    value?: unknown
    fieldData?: Record<string, unknown>
}

interface CarouselImageItem {
    image?: ResponsiveImageValue
}

interface CMSProductCarouselProps {
    carouselImages?: CarouselImageItem[]
    coverFallback?: ResponsiveImageValue
    arrows?: boolean
    dots?: boolean
    autoPlay?: boolean
    interval?: number
    imageFit?: "cover" | "contain"
    arrowBackground?: string
    arrowColour?: string
    dotColour?: string
    style?: CSSProperties
}

function normalizeImage(value: unknown): ResponsiveImageValue | null {
    if (!value) return null
    if (typeof value === "string") return { src: value }
    if (typeof value !== "object") return null

    const image = value as ResponsiveImageValue
    if (typeof image.src === "string") return image
    if (typeof image.url === "string") {
        return { src: image.url, alt: image.alt }
    }
    if (image.value) {
        const nested = normalizeImage(image.value)
        if (nested) return nested
    }
    if (image.fieldData) {
        for (const nestedValue of Object.values(image.fieldData)) {
            const nested = normalizeImage(nestedValue)
            if (nested) return nested
        }
    }
    return null
}

function Chevron({ direction }: { direction: "left" | "right" }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: direction === "left" ? "rotate(180deg)" : undefined }}
        >
            <path d="m9 5 7 7-7 7" />
        </svg>
    )
}

/**
 * CMS Product Carousel
 *
 * @framerIntrinsicWidth 400
 * @framerIntrinsicHeight 420
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight any-prefer-fixed
 */
export default function CMSProductCarousel(props: CMSProductCarouselProps) {
    const {
        carouselImages = [],
        coverFallback,
        arrows = true,
        dots = true,
        autoPlay = false,
        interval = 4,
        imageFit = "cover",
        arrowBackground = "rgba(250, 248, 244, 0.94)",
        arrowColour = "#738063",
        dotColour = "#738063",
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const [current, setCurrent] = useState(0)
    const [direction, setDirection] = useState(1)
    const pointerStart = useRef<number | null>(null)

    const images = useMemo(() => {
        const galleryImages = Array.isArray(carouselImages)
            ? carouselImages
                  .map((item) => normalizeImage(item?.image ?? item))
                  .filter(
                      (image): image is ResponsiveImageValue =>
                          Boolean(image?.src)
                  )
            : []
        if (galleryImages.length > 0) return galleryImages
        const fallback = normalizeImage(coverFallback)
        return fallback?.src ? [fallback] : []
    }, [carouselImages, coverFallback])

    const imageSignature = images.map((image) => image.src).join("|")

    useEffect(() => {
        startTransition(() => {
            setCurrent(0)
            setDirection(1)
        })
    }, [imageSignature])

    useEffect(() => {
        if (isStatic || !autoPlay || images.length < 2) return
        const timer = window.setInterval(() => {
            startTransition(() => {
                setDirection(1)
                setCurrent((value) => (value + 1) % images.length)
            })
        }, Math.max(2, interval) * 1000)
        return () => window.clearInterval(timer)
    }, [autoPlay, images.length, interval, isStatic])

    const goTo = (index: number) => {
        if (images.length < 2) return
        const next = Math.max(0, Math.min(images.length - 1, index))
        if (next === current) return
        setDirection(next > current ? 1 : -1)
        startTransition(() => setCurrent(next))
    }

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        pointerStart.current = event.clientX
    }

    const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (pointerStart.current === null) return
        const distance = event.clientX - pointerStart.current
        pointerStart.current = null
        if (Math.abs(distance) < 35) return
        goTo(current + (distance < 0 ? 1 : -1))
    }

    const active = images[current] ?? images[0]
    const carouselClassName = isStatic
        ? "mm-product-carousel mm-carousel-static"
        : "mm-product-carousel"

    const css = `
        .mm-product-carousel .mm-carousel-arrow {
            opacity: 1;
            transition: opacity 180ms ease, transform 180ms ease;
        }
        .mm-product-carousel .mm-carousel-arrow-visual {
            transition: transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
        }
        .mm-product-carousel .mm-carousel-arrow:hover .mm-carousel-arrow-visual {
            transform: scale(1.05);
            box-shadow: 0 5px 18px rgba(51, 43, 37, 0.16);
        }
        .mm-product-carousel .mm-carousel-arrow:active .mm-carousel-arrow-visual {
            transform: scale(0.96);
        }
        .mm-product-carousel .mm-carousel-arrow:focus-visible {
            outline: none;
        }
        .mm-product-carousel .mm-carousel-arrow:focus-visible .mm-carousel-arrow-visual {
            outline: 2px solid ${arrowColour};
            outline-offset: 2px;
        }
        @media (hover: hover) and (pointer: fine) {
            .mm-product-carousel:not(.mm-carousel-static) .mm-carousel-arrow {
                opacity: 0;
                pointer-events: none;
            }
            .mm-product-carousel:not(.mm-carousel-static):hover .mm-carousel-arrow,
            .mm-product-carousel:not(.mm-carousel-static):focus-within .mm-carousel-arrow {
                opacity: 1;
                pointer-events: auto;
            }
        }
        @media (prefers-reduced-motion: reduce) {
            .mm-product-carousel .mm-carousel-arrow,
            .mm-product-carousel .mm-carousel-arrow-visual,
            .mm-product-carousel .mm-carousel-dot-visual {
                transition: none !important;
            }
        }
    `

    return (
        <div
            className={carouselClassName}
            style={{
                ...style,
                position: "relative",
                width: "100%",
                height: "100%",
                overflow: "hidden",
                background: "#EAE6E3",
                touchAction: "pan-y",
            }}
            onPointerDown={isStatic ? undefined : onPointerDown}
            onPointerUp={isStatic ? undefined : onPointerUp}
            onPointerCancel={() => {
                pointerStart.current = null
            }}
            role="region"
            aria-roledescription="carousel"
            aria-label="Product images"
        >
            <style>{css}</style>
            {active?.src ? (
                <AnimatePresence mode="wait" initial={false}>
                    <motion.img
                        key={(active.src || "product-image") + current}
                        src={active.src}
                        srcSet={active.srcSet}
                        alt={active.alt || "Product image " + (current + 1)}
                        initial={
                            isStatic
                                ? false
                                : { opacity: 0.72, x: direction * 18 }
                        }
                        animate={{ opacity: 1, x: 0 }}
                        exit={
                            isStatic
                                ? undefined
                                : { opacity: 0.72, x: direction * -18 }
                        }
                        transition={{
                            duration: 0.25,
                            ease: [0.22, 1, 0.36, 1],
                        }}
                        draggable={false}
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            objectFit: imageFit,
                            objectPosition: "center",
                            userSelect: "none",
                        }}
                    />
                </AnimatePresence>
            ) : null}

            {images.length > 1 && arrows && current > 0 ? (
                <button
                    className="mm-carousel-arrow"
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation()
                        goTo(current - 1)
                    }}
                    aria-label="Previous product image"
                    style={{ ...arrowHitStyle, left: 8, color: arrowColour }}
                >
                    <span
                        className="mm-carousel-arrow-visual"
                        style={{
                            ...arrowVisualStyle,
                            background: arrowBackground,
                        }}
                    >
                        <Chevron direction="left" />
                    </span>
                </button>
            ) : null}

            {images.length > 1 && arrows && current < images.length - 1 ? (
                <button
                    className="mm-carousel-arrow"
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation()
                        goTo(current + 1)
                    }}
                    aria-label="Next product image"
                    style={{ ...arrowHitStyle, right: 8, color: arrowColour }}
                >
                    <span
                        className="mm-carousel-arrow-visual"
                        style={{
                            ...arrowVisualStyle,
                            background: arrowBackground,
                        }}
                    >
                        <Chevron direction="right" />
                    </span>
                </button>
            ) : null}

            {images.length > 1 && dots ? (
                <div
                    aria-label="Choose product image"
                    style={{
                        position: "absolute",
                        left: "50%",
                        bottom: 12,
                        transform: "translateX(-50%)",
                        display: "flex",
                        gap: 6,
                        padding: "6px 8px",
                        borderRadius: 999,
                        border: "1px solid rgba(115, 128, 99, 0.18)",
                        background: "rgba(250, 248, 244, 0.86)",
                        backdropFilter: "blur(6px)",
                        boxShadow: "0 3px 12px rgba(51, 43, 37, 0.08)",
                    }}
                >
                    {images.map((image, index) => (
                        <button
                            className="mm-carousel-dot"
                            key={(image.src || "image") + index}
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation()
                                goTo(index)
                            }}
                            aria-label={"Show product image " + (index + 1)}
                            aria-current={index === current ? "true" : undefined}
                            style={{
                                width: 44,
                                height: 44,
                                padding: 0,
                                border: 0,
                                borderRadius: 999,
                                display: "grid",
                                placeItems: "center",
                                background: "transparent",
                                cursor: "pointer",
                            }}
                        >
                            <span
                                className="mm-carousel-dot-visual"
                                style={{
                                    width: index === current ? 16 : 7,
                                    height: 7,
                                    borderRadius: 999,
                                    background: dotColour,
                                    opacity: index === current ? 1 : 0.45,
                                    transition: "width 180ms ease, opacity 180ms ease",
                                }}
                            />
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

const arrowHitStyle: CSSProperties = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    width: 44,
    height: 44,
    padding: 0,
    border: 0,
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    background: "transparent",
    cursor: "pointer",
    zIndex: 2,
}

const arrowVisualStyle: CSSProperties = {
    width: 34,
    height: 34,
    borderRadius: 999,
    border: "1px solid rgba(115, 128, 99, 0.34)",
    display: "grid",
    placeItems: "center",
    boxShadow: "0 3px 12px rgba(51, 43, 37, 0.12)",
    backdropFilter: "blur(6px)",
}

addPropertyControls<CMSProductCarouselProps>(CMSProductCarousel, {
    carouselImages: {
        type: ControlType.Array,
        title: "Carousel Images",
        control: {
            type: ControlType.Object,
            controls: {
                image: {
                    type: ControlType.ResponsiveImage,
                    title: "Image",
                },
            },
        },
        defaultValue: [{ image: {} }],
        maxCount: 20,
    },
    coverFallback: {
        type: ControlType.ResponsiveImage,
        title: "Cover Fallback",
    },
    arrows: {
        type: ControlType.Boolean,
        title: "Arrows",
        defaultValue: true,
    },
    dots: {
        type: ControlType.Boolean,
        title: "Dots",
        defaultValue: true,
    },
    autoPlay: {
        type: ControlType.Boolean,
        title: "Auto Play",
        defaultValue: false,
    },
    interval: {
        type: ControlType.Number,
        title: "Interval",
        defaultValue: 4,
        min: 2,
        max: 12,
        step: 0.5,
        unit: "s",
        hidden: (props) => !props.autoPlay,
    },
    imageFit: {
        type: ControlType.Enum,
        title: "Image Fit",
        options: ["cover", "contain"],
        optionTitles: ["Cover", "Contain"],
        defaultValue: "cover",
        displaySegmentedControl: true,
    },
    arrowBackground: {
        type: ControlType.Color,
        title: "Arrow Background",
        defaultValue: "rgba(250, 248, 244, 0.94)",
        hidden: (props) => !props.arrows,
    },
    arrowColour: {
        type: ControlType.Color,
        title: "Arrow Colour",
        defaultValue: "#738063",
        hidden: (props) => !props.arrows,
    },
    dotColour: {
        type: ControlType.Color,
        title: "Dot Colour",
        defaultValue: "#738063",
        hidden: (props) => !props.dots,
    },
})
