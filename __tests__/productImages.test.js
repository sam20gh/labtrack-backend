/**
 * The product gallery.
 *
 * Four things are asserted, and the first is the one that would otherwise fail silently.
 *
 * A `file://` path is what an image picker hands back before anything is uploaded, and a
 * catalogue that stores one shows a product picture on the device that chose it and a
 * broken square everywhere else — invisible from the server, which accepted the write. The
 * same guard `createMeal` puts in front of the nutrition gallery.
 *
 * `image` is the cover and must always be `images[0]`, because three mobile screens and
 * the basket read it and know nothing about a gallery.
 *
 * The update path takes a whitelist rather than the request body, so a stray field cannot
 * write itself onto the document that `planGeneratorV2` substring-matches screenings
 * against.
 */
const Product = require('../models/Product');
const {
    addProduct,
    updateProduct,
    _internal: { MAX_IMAGES },
} = require('../controllers/productController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const cf = (n) => `https://imagedelivery.net/abc123/${n}/public`;

const create = async (body = {}) => {
    const res = mockRes();
    await addProduct(
        { body: { name: 'Lipid Panel', sku: `LP-${Math.random().toString(36).slice(2, 8)}`, price: 49, ...body } },
        res
    );
    return res.json.mock.calls[0][0];
};

describe('creating a product with pictures', () => {
    it('stores the gallery and derives the cover from its first entry', async () => {
        const product = await create({ images: [cf('one'), cf('two')] });

        expect(product.images).toEqual([cf('one'), cf('two')]);
        expect(product.image).toBe(cf('one'));
    });

    it('refuses a local file path, which renders on one device and nowhere else', async () => {
        const product = await create({
            images: ['file:///var/mobile/Containers/cache/IMG_0001.jpg', cf('real')],
        });

        expect(product.images).toEqual([cf('real')]);
        expect(product.image).toBe(cf('real'));
    });

    it('refuses http, and anything that is not a string', async () => {
        const product = await create({ images: ['http://example.com/a.jpg', null, 42, cf('ok')] });

        expect(product.images).toEqual([cf('ok')]);
    });

    it('de-duplicates, so re-uploading the same picture does not double the gallery', async () => {
        const product = await create({ images: [cf('one'), cf('one'), cf('two')] });

        expect(product.images).toEqual([cf('one'), cf('two')]);
    });

    it('caps the gallery — the catalogue is loaded whole by the home screen', async () => {
        const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => cf(`img-${i}`));
        const product = await create({ images: many });

        expect(product.images).toHaveLength(MAX_IMAGES);
    });

    it('accepts a lone `image`, the shape every client sent before the gallery existed', async () => {
        const product = await create({ image: cf('legacy') });

        expect(product.image).toBe(cf('legacy'));
        expect(product.images).toEqual([cf('legacy')]);
    });
});

describe('updating a product', () => {
    it('leaves the gallery alone when the update does not mention pictures', async () => {
        const created = await create({ images: [cf('one'), cf('two')] });

        const res = mockRes();
        await updateProduct({ params: { id: created._id }, body: { price: 59 } }, res);
        const updated = res.json.mock.calls[0][0];

        expect(updated.price).toBe(59);
        expect(updated.images).toEqual([cf('one'), cf('two')]);
        expect(updated.image).toBe(cf('one'));
    });

    it('replaces the gallery, and moves the cover with it', async () => {
        const created = await create({ images: [cf('one'), cf('two')] });

        const res = mockRes();
        await updateProduct(
            { params: { id: created._id }, body: { images: [cf('two'), cf('three')] } },
            res
        );
        const updated = res.json.mock.calls[0][0];

        expect(updated.images).toEqual([cf('two'), cf('three')]);
        expect(updated.image).toBe(cf('two'));
    });

    it('promotes a lone `image` to the front of the gallery rather than discarding it', async () => {
        const created = await create({ images: [cf('one'), cf('two')] });

        const res = mockRes();
        await updateProduct({ params: { id: created._id }, body: { image: cf('two') } }, res);
        const updated = res.json.mock.calls[0][0];

        expect(updated.image).toBe(cf('two'));
        expect(updated.images).toEqual([cf('two'), cf('one')]);
    });

    it('clears both when the cover is explicitly removed', async () => {
        const created = await create({ images: [cf('one')] });

        const res = mockRes();
        await updateProduct({ params: { id: created._id }, body: { image: null } }, res);
        const updated = res.json.mock.calls[0][0];

        expect(updated.image).toBeNull();
        expect(updated.images).toEqual([]);
    });

    it('ignores fields outside the whitelist instead of writing them', async () => {
        const created = await create();

        const res = mockRes();
        await updateProduct(
            { params: { id: created._id }, body: { name: 'Renamed', _id: 'hijack', proMember: true } },
            res
        );
        const updated = res.json.mock.calls[0][0];

        expect(updated.name).toBe('Renamed');
        expect(String(updated._id)).toBe(String(created._id));
        expect(updated.toObject().proMember).toBeUndefined();
    });

    it('answers 404 for a product that does not exist', async () => {
        const res = mockRes();
        await updateProduct(
            { params: { id: new (require('mongoose').Types.ObjectId)() }, body: { price: 1 } },
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
    });
});

describe('the stored document', () => {
    it('keeps cover and gallery in step on the record, not just in the response', async () => {
        const created = await create({ images: [cf('one'), cf('two')] });
        const fromDb = await Product.findById(created._id);

        expect(fromDb.image).toBe(fromDb.images[0]);
    });
});
